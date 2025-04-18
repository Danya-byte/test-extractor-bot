require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const Redis = require('ioredis');
const Logger = require('./logger');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT
});

const userData = async (chatId, data) => {
  if (data) await redis.set(`user:${chatId}`, JSON.stringify(data));
  return JSON.parse(await redis.get(`user:${chatId}`) || '{}');
};

async function requestWithRetries(method, url, body, config = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      Logger.info(`Попытка ${attempt}/${retries} для запроса`, { method, url });
      const response = await axios({
        method,
        url,
        data: body,
        ...config
      });
      Logger.info(`Запрос успешен`, { method, url, status: response.status });
      return response;
    } catch (error) {
      Logger.error(`Ошибка запроса, попытка ${attempt}/${retries}`, { method, url, error: error.message });
      if (attempt === retries) {
        Logger.error(`Все попытки исчерпаны`, { method, url, error: error.message });
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

async function requestActiveTab(chatId) {
  try {
    if (!chatId) {
      Logger.error(`chatId отсутствует`, { chatId });
      throw new Error('chatId отсутствует');
    }
    Logger.info(`Отправка команды расширению`, { chatId, url: `${process.env.SERVER_URL}/trigger-extension` });
    const triggerResponse = await requestWithRetries('post', `${process.env.SERVER_URL}/trigger-extension`,
      { chatId, action: 'get-active-tab' },
      { timeout: 30000 }
    );
    Logger.info(`Ответ от /trigger-extension`, { chatId, response: triggerResponse.data });
    Logger.info(`Ожидание данных от расширения`, { chatId });
    await new Promise(resolve => setTimeout(resolve, 15000));
    Logger.info(`Запрос данных вкладок`, { chatId, url: `${process.env.SERVER_URL}/tabs` });
    const response = await requestWithRetries('get', `${process.env.SERVER_URL}/tabs`,
      null,
      { headers: { 'X-Telegram-Chat-Id': chatId }, timeout: 30000 }
    );
    const tabsData = response.data;
    Logger.info(`Получены данные вкладок`, { chatId, tabCount: tabsData.length, data: tabsData });
    if (!tabsData || !tabsData.length) {
      Logger.info(`Вкладки не найдены`, { chatId });
      bot.sendMessage(chatId, 'Активная вкладка с тестом не найдена.');
      return null;
    }
    await userData(chatId, { tabs: tabsData, questions: [] });
    return tabsData;
  } catch (error) {
    Logger.error(`Ошибка получения вкладок`, { chatId, error: error.message, stack: error.stack });
    bot.sendMessage(chatId, `Ошибка: ${error.message}. Убедитесь, что сервер доступен.`);
    return null;
  }
}

function createCombinedPrompt(questions) {
  const combinedPrompt = questions.map((q, index) => {
    if (q.type === 'text') {
      return `Вопрос ${index + 1} (текстовый, ID: ${q.questionId || 'неизвестно'}): ${q.question}`;
    } else {
      const typeHint = q.isMultipleChoice ? "(множественный выбор)" : "(одиночный выбор)";
      return `Вопрос ${index + 1} ${typeHint} (ID: ${q.questionId || 'неизвестно'}): ${q.question}\nВарианты:\n${q.options.map((opt, i) => `${i + 1}. ${opt}`).join("\n")}`;
    }
  }).join('\n\n') + "\n\nДайте точные и полные ответы на русском языке в формате: 'Ответ X: [текст]' для текстовых вопросов или 'Ответ X: [цифра]. [текст]' или 'Ответ X: [цифра]. [текст], [цифра]. [текст]' для вопросов с вариантами.";
  return combinedPrompt;
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  Logger.info(`Получена команда /start`, { chatId });
  await redis.sadd('users', chatId);
  bot.sendMessage(chatId, 'Привет! Я помогу с тестами. Нажми "Получить вопросы"', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Получить вопросы', callback_data: 'get_questions' }]]
    }
  });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const isUser = await redis.sismember('users', chatId);
  if (!isUser) {
    bot.sendMessage(chatId, 'Пожалуйста, начните с /start');
    return;
  }
  const data = query.data;
  Logger.info(`Получен callback`, { chatId, data });
  if (data === 'get_questions' || data === 'refresh_active_tab') {
    bot.editMessageText('Начинаю обработку...', { chat_id: chatId, message_id: query.message.message_id });
    const tabsData = await requestActiveTab(chatId);
    if (tabsData) {
      let message = `Активная вкладка: ${tabsData[0].title}\n\n`;
      const questionCount = tabsData[0].questions.length > 3 ? 3 : tabsData[0].questions.length || 3;
      for (let i = 0; i < questionCount; i++) {
        const q = tabsData[0].questions[i];
        let questionText = `Вопрос ${i + 1}: ${q.question}`;
        if (q.options && q.options.length) {
          questionText += `\n${q.options.map((opt, j) => `${j + 1}. ${opt}`).join('\n')}`;
        }
        message += `<blockquote expandable>${questionText}</blockquote>\n\n`;
      }
      message += 'Проверьте, ваши ли это вопросы, и выберите действие:';
      await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Получить ответы', callback_data: `select_tab:0` }],
            [{ text: 'Обновить', callback_data: 'refresh_active_tab' }]
          ]
        }
      });
    }
  } else if (data.startsWith('select_tab:')) {
    const tabIndex = parseInt(data.split(':')[1], 10);
    bot.editMessageText('Ожидайте...', { chat_id: chatId, message_id: query.message.message_id });
    try {
      const user = await userData(chatId);
      if (!user || !user.tabs || !user.tabs[tabIndex]) {
        Logger.error(`Данные пользователя или вкладки не найдены`, { chatId, tabIndex });
        bot.sendMessage(chatId, 'Ошибка: данные вкладки не найдены. Попробуйте начать заново с /start.');
        return;
      }
      const selectedTab = user.tabs[tabIndex];
      Logger.info(`Запрос на скрейпинг`, { chatId, url: selectedTab.url });
      const response = await requestWithRetries('post', `${process.env.SERVER_URL}/scrape`,
        { url: selectedTab.url, cookies: selectedTab.cookies || [] },
        { timeout: 30000 }
      );
      const { questions, combinedPrompt } = response.data;
      await userData(chatId, { ...user, questions });
      Logger.info(`Получены полные вопросы`, { chatId, url: selectedTab.url, questionCount: questions.length });
      Logger.info(`Запрос на обработку вопросов`, { chatId, questionCount: questions.length });
      const aiResponse = await requestWithRetries('post', `${process.env.SERVER_URL}/process-questions`,
        { questions, combinedPrompt, model: 'deepseek/deepseek-r1:free' },
        { timeout: 45000 }
      );
      if (aiResponse.status !== 200 || aiResponse.data.error) {
        throw new Error(aiResponse.data.error || 'Ошибка при получении ответов от ИИ');
      }
      const results = aiResponse.data.results;
      Logger.info(`Получены ответы от ИИ`, { chatId, resultCount: results.length });
      let userDataUpdate = { ...user, questions: results, messageIds: {} };
      const QUESTIONS_PER_MESSAGE = 5;
      for (let i = 0; i < results.length; i += QUESTIONS_PER_MESSAGE) {
        let message = '';
        const endIndex = Math.min(i + QUESTIONS_PER_MESSAGE, results.length);
        const buttons = [];
        for (let j = i; j < endIndex; j++) {
          const result = results[j];
          message += `<b>Вопрос ${j + 1}: ${result.question}</b>\n\n`;
          message += `<b>Ответ: ${result.answer.replace(/^Ответ \d+:\s*/, '')}</b>\n`;
          if (result.options && result.options.length) {
            message += `<blockquote expandable>Варианты:\n${result.options.map((opt, k) => `${k + 1}. ${opt}`).join('\n')}</blockquote>`;
          }
          message += '\n\n';
          buttons.push([{ text: `Перегенерировать ответ ${j + 1}`, callback_data: `regenerate:${j + 1}` }]);
        }
        Logger.info(`Отправка вопросов ${i + 1}-${endIndex}`, { chatId, messageLength: message.length });
        const sentMessage = await bot.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: buttons
          }
        });
        userDataUpdate.messageIds[i] = sentMessage.message_id;
      }
      await userData(chatId, userDataUpdate);
      bot.sendMessage(chatId, 'Все вопросы обработаны! Если вы хотите перегенерировать ответ на конкретный вопрос, используйте кнопки выше.');
    } catch (error) {
      Logger.error(`Ошибка обработки страницы`, { chatId, error: error.message, stack: error.stack });
      bot.sendMessage(chatId, `Ошибка: ${error.message}. Попробуй снова.`);
    }
  } else if (data.startsWith('regenerate:')) {
    const questionNumber = parseInt(data.split(':')[1], 10);
    Logger.info(`Нажата кнопка перегенерации`, { chatId, questionNumber });
    const user = await userData(chatId);
    if (!user || !user.questions || user.questions.length < questionNumber || questionNumber <= 0) {
      bot.sendMessage(chatId, 'Некорректный номер вопроса или вопросы не найдены.');
      return;
    }
    const question = user.questions[questionNumber - 1];
    try {
      Logger.info(`Запрос на перегенерацию ответа`, { chatId, questionNumber });
      const aiResponse = await requestWithRetries('post', `${process.env.SERVER_URL}/process-questions`,
        { questions: [question], combinedPrompt: createCombinedPrompt([question]), model: 'deepseek/deepseek-r1:free' },
        { timeout: 30000 }
      );
      if (aiResponse.status !== 200 || aiResponse.data.error) {
        throw new Error(aiResponse.data.error || 'Ошибка при получении ответа от ИИ');
      }
      const newAnswer = aiResponse.data.results[0].answer;
      Logger.info(`Получен новый ответ`, { chatId, questionNumber, newAnswer });
      user.questions[questionNumber - 1].answer = newAnswer;
      const QUESTIONS_PER_MESSAGE = 5;
      const batchIndex = Math.floor((questionNumber - 1) / QUESTIONS_PER_MESSAGE) * QUESTIONS_PER_MESSAGE;
      const messageId = user.messageIds[batchIndex];
      if (!messageId) {
        Logger.error(`Message ID не найден для пачки`, { chatId, batchIndex });
        bot.sendMessage(chatId, 'Не удалось обновить сообщение. Попробуйте снова.');
        return;
      }
      let updatedMessage = '';
      const endIndex = Math.min(batchIndex + QUESTIONS_PER_MESSAGE, user.questions.length);
      for (let j = batchIndex; j < endIndex; j++) {
        const result = user.questions[j];
        updatedMessage += `Вопрос ${j + 1}: ${result.question}\n\n`;
        if (j + 1 === questionNumber) {
          updatedMessage += `<b>Новый ответ: ${newAnswer.replace(/^Ответ \d+:\s*/, '')}</b>\n`;
        } else {
          updatedMessage += `<b>Ответ: ${result.answer.replace(/^Ответ \d+:\s*/, '')}</b>\n`;
        }
        if (result.options && result.options.length) {
          updatedMessage += `<blockquote expandable>Варианты:\n${result.options.map((opt, k) => `${k + 1}. ${opt}`).join('\n')}</blockquote>`;
        }
        updatedMessage += '\n\n';
      }
      const buttons = [];
      for (let j = batchIndex; j < endIndex; j++) {
        buttons.push([{ text: `Перегенерировать ответ ${j + 1}`, callback_data: `regenerate:${j + 1}` }]);
      }
      await bot.editMessageText(updatedMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: buttons
        }
      });
      await userData(chatId, user);
    } catch (error) {
      Logger.error(`Ошибка перегенерации ответа`, { chatId, questionNumber, error: error.message, stack: error.stack });
      bot.sendMessage(chatId, `Не удалось перегенерировать ответ на вопрос ${questionNumber}. Попробуйте еще раз.`);
    }
  }
});

bot.on('polling_error', (error) => {
  Logger.error(`Ошибка polling`, { error: error.message, stack: error.stack });
});

process.on('SIGINT', async () => {
  await redis.quit();
  process.exit();
});
