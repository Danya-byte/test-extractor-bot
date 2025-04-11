require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { Cluster } = require('puppeteer-cluster');
puppeteer.use(StealthPlugin());
const express = require('express');
const Redis = require('ioredis');
const cors = require('cors');
const app = express();
const OpenAI = require('openai');
const prom = require('prom-client');
const Logger = require('./logger');

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT
});

app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS.split(',');
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith('chrome-extension://')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Chat-Id']
}));
app.use(express.json());

const register = new prom.Registry();
prom.collectDefaultMetrics({ register });

const httpRequestDuration = new prom.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.1, 0.5, 1, 2, 5],
  registers: [register]
});

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.path, code: res.statusCode });
  });
  next();
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', prom.register.contentType);
  res.end(await register.metrics());
});

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY
});

let cluster;

async function launchCluster() {
  Logger.info('Запуск кластера Puppeteer');
  cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_PAGE,
    maxConcurrency: 10,
    puppeteerOptions: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: 60000
    }
  });
  Logger.info('Кластер успешно запущен');
  return cluster;
}

async function ensureCluster() {
  if (!cluster) {
    return await launchCluster();
  }
  return cluster;
}

const getTabStorage = async (chatId) => JSON.parse(await redis.get(`tabs:${chatId}`) || '[]');
const setTabStorage = async (chatId, data) => await redis.set(`tabs:${chatId}`, JSON.stringify(data));
const getPendingCommands = async (chatId) => JSON.parse(await redis.get(`commands:${chatId}`) || '{}');
const setPendingCommands = async (chatId, data) => await redis.set(`commands:${chatId}`, JSON.stringify(data));
const getUrlCache = async (urlKey) => JSON.parse(await redis.get(`cache:${urlKey}`) || 'null');
const setUrlCache = async (urlKey, data) => await redis.set(`cache:${urlKey}`, JSON.stringify(data));
const setProcessingStatus = async (chatId, status) => await redis.set(`processing:${chatId}`, status);
const getProcessingStatus = async (chatId) => await redis.get(`processing:${chatId}`);

app.post('/trigger-extension', async (req, res) => {
  const { chatId, action } = req.body;
  Logger.info(`Инициирована отправка команды расширению`, { chatId, action });
  await setPendingCommands(chatId.toString(), { command: action, chatId });
  await setProcessingStatus(chatId, 'pending');
  res.json({ message: 'Команда сохранена, ожидается обработка расширением' });
});

app.get('/check-commands', async (req, res) => {
  Logger.info(`Проверка команд от расширения`);
  const commands = await redis.keys('commands:*');
  if (commands.length > 0) {
    const chatId = commands[0].split(':')[1];
    const command = await getPendingCommands(chatId);
    await redis.del(`commands:${chatId}`);
    Logger.info(`Команда найдена`, { chatId, command });
    res.json(command);
  } else {
    res.json({ command: null, chatId: null });
  }
});

app.get('/tabs', async (req, res) => {
  const chatId = req.headers['x-telegram-chat-id'];
  Logger.info(`Получен GET-запрос на вкладки от бота`, { chatId });
  const tabsData = await getTabStorage(chatId);
  res.json(tabsData);
});

app.post('/tabs', async (req, res) => {
  const chatId = req.headers['x-telegram-chat-id'];
  const { urls, titles, cookies } = req.body;
  if (!urls || !Array.isArray(urls) || !titles || !Array.isArray(titles)) {
    Logger.error('Некорректные данные от расширения', { urls, titles });
    await setProcessingStatus(chatId, 'failed');
    return res.status(400).json({ error: 'URLs и titles обязательны и должны быть массивами' });
  }
  try {
    const filteredUrls = urls.filter(url => url.startsWith('https://courses.openedu.ru') || url.startsWith('https://apps.openedu.ru'));
    Logger.info(`Получены вкладки`, { count: filteredUrls.length, urls: filteredUrls });
    await ensureCluster();
    const results = [];
    await cluster.task(async ({ page, data: { url, title, urlCookies } }) => {
      await page.setCookie(...urlCookies);
      await loadPageWithRetries(page, url);
      const { questions } = await extractQuestionsAndOptions(page);
      results.push({ url, title, questions, cookies: urlCookies });
    });
    for (let i = 0; i < filteredUrls.length; i++) {
      await cluster.queue({
        url: filteredUrls[i],
        title: titles[i] || 'Без названия',
        urlCookies: cookies.find(c => c.url === filteredUrls[i])?.cookies || []
      });
    }
    await cluster.idle();
    Logger.info(`Сохранение данных в tabStorage`, { chatId, resultCount: results.length });
    await setTabStorage(chatId, results);
    await setProcessingStatus(chatId, results.length > 0 ? 'completed' : 'failed');
    res.json(results);
  } catch (error) {
    Logger.error(`Ошибка обработки вкладок`, { error: error.message, stack: error.stack });
    await setProcessingStatus(chatId, 'failed');
    res.status(500).json({ error: error.message || 'Ошибка обработки вкладок' });
  }
});

app.post('/scrape', async (req, res) => {
  Logger.info(`Получен запрос на скрейпинг`, { url: req.body.url, cookieCount: req.body.cookies?.length || 0 });
  const { url, cookies } = req.body;
  if (!url) {
    Logger.error(`Некорректный запрос`, { url });
    return res.status(400).json({ error: 'URL обязателен' });
  }
  const urlKey = url.hashCode();
  const cachedResult = await getUrlCache(urlKey);
  if (cachedResult) {
    Logger.info(`Использование кэша`, { urlKey, url });
    return res.json(cachedResult);
  }
  try {
    await ensureCluster();
    let result;
    await cluster.task(async ({ page }) => {
      if (cookies && cookies.length) {
        const domain = new URL(url).hostname;
        const formattedCookies = cookies.map(cookie => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain || `.${domain}`,
          path: '/',
          expires: cookie.expirationDate ? cookie.expirationDate * 1000 : -1
        }));
        await page.setCookie(...formattedCookies);
      }
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');
      await loadPageWithRetries(page, url);
      const { questions } = await extractQuestionsAndOptions(page);
      const combinedPrompt = createCombinedPrompt(questions);
      result = { questions, combinedPrompt };
    });
    await cluster.queue();
    await cluster.idle();
    Logger.info(`Успешный скрейпинг`, { url, questionCount: result.questions.length });
    await setUrlCache(urlKey, result);
    res.json(result);
  } catch (error) {
    Logger.error(`Ошибка скрейпинга`, { url, error: error.message, stack: error.stack });
    res.status(500).json({ error: error.message || 'Ошибка парсинга' });
  }
});

app.post('/process-questions', async (req, res) => {
  const { questions, combinedPrompt, model } = req.body;
  Logger.info(`Получен запрос на обработку вопросов`, { questionCount: questions.length, model });
  try {
    Logger.info(`Отправка запроса к ИИ`, { model, promptLength: combinedPrompt.length });
    const completion = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Ты — эксперт. Верни ответы в формате: "Ответ X: [текст]" для текстовых вопросов или "Ответ X: [цифра]. [текст]" или "Ответ X: [цифра]. [текст], [цифра]. [текст]" для вопросов с вариантами.'
        },
        { role: 'user', content: combinedPrompt }
      ],
      max_tokens: 16000,
      headers: {
        "HTTP-Referer": process.env.SERVER_URL,
        "X-Title": "Proktoring Helper"
      }
    });
    const rawContent = completion.choices[0].message.content.trim();
    const answerLines = rawContent.split('\n').filter(line => line.trim());
    const allAnswers = new Array(questions.length).fill(null);
    for (const line of answerLines) {
      const match = line.match(/Ответ (\d+):\s*(.+)/);
      if (match) {
        const questionNumber = parseInt(match[1], 10);
        const answerText = match[2].trim();
        if (questionNumber > 0 && questionNumber <= questions.length) {
          allAnswers[questionNumber - 1] = answerText;
        }
      }
    }
    const results = questions.map((q, i) => ({
      question: q.question,
      answer: allAnswers[i] || 'Ответ неизвестен',
      options: q.options || []
    }));
    Logger.info(`Получены ответы от ИИ`, { resultCount: results.length });
    res.json({ results, modelSwitched: false, currentModel: model });
  } catch (error) {
    Logger.error(`Ошибка обработки ИИ`, { error: error.message, stack: error.stack });
    const results = questions.map((q, i) => ({
      question: q.question,
      answer: 'Ответ будет добавлен позже (ошибка ИИ)',
      options: q.options || []
    }));
    res.json({ results, modelSwitched: false, currentModel: model });
  }
});

String.prototype.hashCode = function() {
  let hash = 0;
  for (let i = 0; i < this.length; i++) {
    const char = this.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
};

function createCombinedPrompt(questions) {
  Logger.info(`Создание объединённого запроса`, { questionCount: questions.length });
  const combinedPrompt = questions.map((q, index) => {
    if (q.type === 'text') {
      return `Вопрос ${index + 1} (текстовый, ID: ${q.questionId || 'неизвестно'}): ${q.question}`;
    } else {
      const typeHint = q.isMultipleChoice ? "(множественный выбор)" : "(одиночный выбор)";
      return `Вопрос ${index + 1} ${typeHint} (ID: ${q.questionId || 'неизвестно'}): ${q.question}\nВарианты:\n${q.options.map((opt, i) => `${i + 1}. ${opt}`).join("\n")}`;
    }
  }).join('\n\n') + "\n\nДайте точные и полные ответы на русском языке в формате: 'Ответ X: [текст]' для текстовых вопросов или 'Ответ X: [цифра]. [текст]' или 'Ответ X: [цифра]. [текст], [цифра]. [текст]' для вопросов с вариантами.";
  Logger.info(`Объединённый запрос создан`, { length: combinedPrompt.length, preview: combinedPrompt.slice(0, 200) + '...' });
  return combinedPrompt;
}

async function loadPageWithRetries(page, url, maxRetries = 3) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      Logger.info(`Попытка ${attempt + 1}/${maxRetries + 1} загрузить страницу`, { url });
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      Logger.info(`Страница загружена`, { url, status: response.status() });
      return response;
    } catch (error) {
      Logger.error(`Попытка ${attempt + 1} не удалась`, { url, error: error.message });
      attempt++;
      if (attempt > maxRetries) {
        Logger.error(`Не удалось загрузить страницу после ${maxRetries + 1} попыток`, { url, error: error.message });
        throw new Error(`Не удалось загрузить страницу: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

async function extractQuestionsAndOptions(page) {
  Logger.info('Извлечение вопросов и вариантов');
  async function getAllFrames(frame) {
    const frames = [frame];
    const childFrames = await frame.childFrames();
    for (const childFrame of childFrames) {
      const nestedFrames = await getAllFrames(childFrame);
      frames.push(...nestedFrames);
    }
    return frames;
  }
  await page.waitForSelector('iframe#unit-iframe', { timeout: 60000 }).catch(err => {
    Logger.warn(`iframe#unit-iframe не найден`, { error: err.message });
  });
  const frameHandle = await page.$('iframe#unit-iframe');
  const mainFrame = frameHandle ? await frameHandle.contentFrame() : null;
  if (!mainFrame) {
    Logger.warn('Не удалось получить доступ к iframe');
    return { questions: [], expectedQuestionCount: 0 };
  }
  Logger.info('Ожидание полной загрузки iframe');
  await mainFrame.waitForFunction(
    () => document.readyState === 'complete',
    { timeout: 30000 }
  ).catch(err => {
    Logger.warn(`Iframe не завершил загрузку`, { error: err.message });
  });
  Logger.info('Ожидание ключевых элементов');
  await mainFrame.waitForFunction(
    () => document.querySelector('.xblock') || document.querySelector('div.problem') || document.querySelector('div.vert-mod'),
    { timeout: 60000 }
  ).catch(err => {
    Logger.warn(`Ключевые элементы не появились`, { error: err.message });
  });
  const allFrames = await getAllFrames(mainFrame);
  Logger.info(`Найдено фреймов`, { count: allFrames.length });
  let allQuestions = [];
  let expectedQuestionCount = 0;
  for (const frame of allFrames) {
    Logger.info('Обработка фрейма...');
    const frameQuestions = await frame.evaluate(() => {
      const log = (message) => console.log(`[${new Date().toISOString()}] [Сервер] [Извлечение] ${message}`);
      function extractQuestionFromVert(vert) {
        log('Извлечение из vert');
        const vertHtml = vert.outerHTML.slice(0, 500);
        log(`HTML vert: ${vertHtml}...`);
        const wrappers = vert.querySelectorAll('div.problem .wrapper-problem-response');
        const wrapperCount = wrappers.length;
        log(`Количество wrapper-problem-response в vert: ${wrapperCount}`);
        if (wrapperCount > 0) {
          const questions = [];
          for (const wrapper of wrappers) {
            const questionData = extractQuestionFromWrapper(wrapper);
            if (questionData) questions.push(questionData);
          }
          return questions;
        } else {
          const problemXblocks = vert.querySelectorAll('.xblock');
          const problemCount = problemXblocks.length;
          log(`Количество xblock с проблемами в vert: ${problemCount}`);
          if (problemCount > 0) {
            const questions = [];
            for (const problemXblock of problemXblocks) {
              const questionData = extractQuestionFromElement(problemXblock);
              if (questionData) questions.push(questionData);
            }
            return questions;
          } else {
            const questionData = extractQuestionFromElement(vert);
            return questionData ? [questionData] : [];
          }
        }
      }
      function extractQuestionFromWrapper(wrapper) {
        log('Извлечение из wrapper-problem-response');
        const wrapperHtml = wrapper.outerHTML.slice(0, 500);
        log(`HTML wrapper: ${wrapperHtml}...`);
        return extractQuestionFromElement(wrapper);
      }
      function extractQuestionFromElement(element) {
        log('Извлечение из элемента');
        const elementHtml = element.outerHTML.slice(0, 500);
        log(`HTML элемента: ${elementHtml}...`);
        const isHidden = element.closest('[style*="display: none"]');
        if (isHidden) {
          log('Элемент скрыт, пропускаем');
          return null;
        }
        const problemContainer = element.closest('div.problems-wrapper');
        const problemId = problemContainer ? problemContainer.getAttribute('data-problem-id') : null;
        log(`Problem ID: ${problemId}`);
        let questionText = null;
        function isUnwantedText(text) {
          if (!text) return true;
          const trimmedText = text.trim();
          return trimmedText === "Какая позиция Вам ближе?" ||
                 /^\d+\.\d+\/\d+\.\d+\s+point(s)?\s+\((un)?graded\)$/.test(trimmedText);
        }
        const header = element.querySelector('h3.problem-header');
        if (header) {
          questionText = header.textContent.trim();
          log(`Текст вопроса из h3.problem-header: "${questionText}"`);
        }
        if (!questionText || isUnwantedText(questionText)) {
          log('Текст из h3 нежелательный или отсутствует, ищем через input');
          let firstInput = element.querySelector('div.choicegroup.capa_inputtype div.field > input, input[type="text"]');
          if (!firstInput) {
            firstInput = element.querySelector('div.field > input, div.choicegroup > input');
          }
          if (!firstInput) {
            log('Input не найден');
          } else {
            let problemContainer = firstInput.closest('div.problem');
            if (!problemContainer) {
              problemContainer = firstInput.closest('div[class*="problem"], div[class*="question"]') || element;
            }
            const progressElement = problemContainer.querySelector('div.problem-progress');
            let progressText = '';
            if (progressElement) {
              progressText = progressElement.textContent.trim();
              log(`Найден div.problem-progress с текстом: "${progressText}"`);
            }
            let currentNode = firstInput;
            while (currentNode && currentNode !== problemContainer) {
              const previousSibling = currentNode.previousSibling ||
                                    (currentNode.parentElement && currentNode.parentElement.previousSibling);
              if (!previousSibling) {
                currentNode = currentNode.parentElement;
                continue;
              }
              const textContent = previousSibling.textContent ? previousSibling.textContent.trim() : '';
              if (textContent && textContent.length > 5) {
                if (/^\d+\.\d+\/\d+\.\d+\s+points?\s+\((un)?graded\)$/.test(textContent)) {
                  log(`Пропуск метаданных: "${textContent}"`);
                  currentNode = previousSibling;
                  continue;
                }
                if (progressText && textContent === progressText) {
                  log(`Пропуск текста из div.problem-progress: "${textContent}"`);
                  currentNode = previousSibling;
                  continue;
                }
                if (textContent.toUpperCase().startsWith('ОТВЕТ: ОТВЕТ НЕИЗВЕСТЕН')) {
                  log(`Пропуск текста ответа: "${textContent}"`);
                  currentNode = previousSibling;
                  continue;
                }
                if (isUnwantedText(textContent)) {
                  log(`Текст нежелательный: "${textContent}", продолжаем подъём`);
                  currentNode = previousSibling;
                  continue;
                }
                questionText = textContent;
                break;
              }
              currentNode = previousSibling;
            }
            if (!questionText) {
              const textNodes = [];
              const walker = document.createTreeWalker(problemContainer, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) => {
                  const text = node.textContent.trim();
                  if (!text || text.length < 5) return NodeFilter.FILTER_REJECT;
                  if (/^\d+\.\d+\/\d+\.\d+\s+points?\s+\((un)?graded\)$/.test(text)) return NodeFilter.FILTER_REJECT;
                  if (progressText && text === progressText) return NodeFilter.FILTER_REJECT;
                  if (text.toUpperCase().startsWith('ОТВЕТ: ОТВЕТ НЕИЗВЕСТЕН')) return NodeFilter.FILTER_REJECT;
                  if (isUnwantedText(text)) return NodeFilter.FILTER_REJECT;
                  const parent = node.parentElement;
                  if (parent && parent.closest('[style*="display: none"]')) return NodeFilter.FILTER_REJECT;
                  return NodeFilter.FILTER_ACCEPT;
                }
              });
              while (walker.nextNode()) {
                textNodes.push(walker.currentNode.textContent.trim());
              }
              questionText = textNodes.join(' ').trim();
              log(`Текст вопроса из problemContainer: "${questionText}"`);
            }
          }
        }
        if (!questionText) {
          log('Текст вопроса не найден');
          return null;
        }
        const subQuestion = element.querySelector('div.wrapper-problem-response > p');
        if (subQuestion && subQuestion.textContent.trim()) {
          const subQuestionText = subQuestion.textContent.trim();
          if (subQuestionText !== questionText) {
            questionText = `${questionText} ${subQuestionText}`;
            log(`Добавлен уточняющий вопрос: "${subQuestionText}"`);
          } else {
            log(`Уточняющий вопрос идентичен основному, пропускаем: "${subQuestionText}"`);
          }
        } else {
          log('Уточняющий вопрос не найден');
        }
        log(`Итоговый текст вопроса: "${questionText}"`);
        let questionId = null;
        const textInput = element.querySelector('input[type="text"]');
        if (textInput) {
          const textInputContainer = textInput.closest('div[id]');
          if (textInputContainer) {
            const rawId = textInputContainer.getAttribute('id');
            questionId = rawId ? rawId.replace(/^inputtype_/, '') : null;
            log(`Извлечён questionId для текстового вопроса: "${questionId}"`);
          }
          return {
            problemId,
            questionId,
            question: questionText,
            type: 'text',
            options: []
          };
        }
        let optionElements = Array.from(element.querySelectorAll('div.choicegroup.capa_inputtype div.field > label'));
        if (optionElements.length === 0) {
          optionElements = Array.from(element.querySelectorAll('div.field > label, div.choicegroup > label'));
        }
        if (optionElements.length === 0) {
          log('Варианты ответа не найдены по старой структуре, пробуем новую');
          optionElements = Array.from(element.querySelectorAll('div.choicegroup.capa_inputtype div.field > span.answer-answerized'));
          if (optionElements.length === 0) {
            optionElements = Array.from(element.querySelectorAll('div.field > span'));
          }
        }
        const options = optionElements
          .map(el => el.textContent.trim().replace(/^\d+\.\s*/, ''))
          .filter(opt => opt);
        if (options.length === 0 && !textInput) {
          log('Варианты ответа не найдены, и это не текстовый вопрос');
          return null;
        }
        log(`Варианты: [${options.join(', ')}]`);
        let inputElements = Array.from(element.querySelectorAll('div.choicegroup.capa_inputtype div.field > input'));
        if (inputElements.length === 0) {
          inputElements = Array.from(element.querySelectorAll('div.field > input, div.choicegroup > input'));
        }
        if (inputElements.length > 0) {
          const inputContainer = inputElements[0].closest('div[id]');
          if (inputContainer) {
            const rawId = inputContainer.getAttribute('id');
            questionId = rawId ? rawId.replace(/^input_/, '') : null;
            log(`Извлечён questionId для вопроса с выбором: "${questionId}"`);
          }
        }
        const isMultipleChoice = inputElements.every(input => input.type === 'checkbox');
        return {
          problemId,
          questionId,
          question: questionText,
          type: isMultipleChoice ? 'checkbox' : 'radio',
          options,
          isMultipleChoice
        };
      }
      const xblocks = Array.from(document.querySelectorAll('.xblock.xblock-student_view.xblock-student_view-vertical'));
      log(`Найдено ${xblocks.length} элементов xblock`);
      let questions = [];
      for (const xblock of xblocks) {
        const xblockHtml = xblock.outerHTML.slice(0, 500);
        log(`HTML xblock: ${xblockHtml}...`);
        const vertMod = xblock.querySelector('div.vert-mod');
        if (!vertMod) {
          log('Элемент vert-mod не найден');
          continue;
        }
        const vertModHtml = vertMod.outerHTML.slice(0, 500);
        log(`HTML vert-mod: ${vertModHtml}...`);
        const vertElements = Array.from(vertMod.querySelectorAll('div[class*="vert vert-"]'));
        if (vertElements.length === 0) {
          log('Элементы vert vert-* не найдены');
          continue;
        }
        log(`Найдено ${vertElements.length} элементов vert`);
        for (const vert of vertElements) {
          const vertResult = extractQuestionFromVert(vert);
          questions.push(...vertResult);
        }
      }
      return questions;
    });
    allQuestions.push(...frameQuestions);
    expectedQuestionCount = Math.max(expectedQuestionCount, frameQuestions.length);
  }
  const uniqueQuestions = [];
  const seenQuestions = new Set();
  allQuestions.forEach(q => {
    const key = `${q.problemId || ''}:${q.questionId || ''}:${q.question}`;
    if (!seenQuestions.has(key)) {
      seenQuestions.add(key);
      uniqueQuestions.push(q);
    } else {
      Logger.info(`Удалён дубликат: "${q.question}"`);
    }
  });
  Logger.info(`Извлечение завершено`, { count: uniqueQuestions.length, expectedCount: expectedQuestionCount });
  return {
    questions: uniqueQuestions,
    expectedQuestionCount
  };
}

process.on('SIGINT', async () => {
  if (cluster) {
    Logger.info('Закрытие кластера');
    await cluster.close();
  }
  await redis.quit();
  process.exit();
});

app.listen(process.env.PORT, () => {
  Logger.info(`Сервер запущен на порту ${process.env.PORT}`);
});