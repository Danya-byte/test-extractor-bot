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
  if (data === 'get_questions') {
    bot.editMessageText('Начинаю обработку...', { chat_id: chatId, message_id: query.message.message_id });
    try {
      Logger.info(`Отправка команды расширению`, { chatId, url: `${process.env.SERVER_URL}/trigger-extension` });
      const triggerResponse = await axios.post(`${process.env.SERVER_URL}/trigger-extension`, {
        chatId,
        action: 'get-active-tab'
      }, { timeout: 15000 });
      Logger.info(`Ответ от /trigger-extension`, { chatId, response: triggerResponse.data });
      Logger.info(`Ожидание данных от расширения`, { chatId });
      await new Promise(resolve => setTimeout(resolve, 15000));
      Logger.info(`Запрос данных вкладок`, { chatId, url: `${process.env.SERVER_URL}/tabs` });
      const response = await axios.get(`${process.env.SERVER_URL}/tabs`, {
        headers: { 'X-Telegram-Chat-Id': chatId },
        timeout: 15000
      });
      const tabsData = response.data;
      Logger.info(`Получены данные вкладок`, { chatId, tabCount: tabsData.length, data: tabsData });
      if (!tabsData || !tabsData.length) {
        Logger.info(`Вкладки не найдены`, { chatId });
        bot.sendMessage(chatId, 'Активная вкладка с тестом не найдена.');
        return;
      }
      await userData(chatId, { tabs: tabsData, questions: [] });
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
      Logger.info(`Отправка всех вопросов в одном сообщении`, { chatId, messageLength: message.length });
      await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      await bot.sendMessage(chatId, 'Выберите действие:', {
        reply_markup: {
          inline_keyboard: [[{ text: 'Обработать эту вкладку', callback_data: `select_tab:0` }]]
        }
      });
    } catch (error) {
      Logger.error(`Ошибка получения вкладок`, { chatId, error: error.message, stack: error.stack });
      bot.sendMessage(chatId, `Ошибка: ${error.message}. Убедитесь, что сервер доступен.`);
    }
  } else if (data.startsWith('select_tab:')) {
    const tabIndex = parseInt(data.split(':')[1], 10);
    bot.editMessageText('Начинаю обработку теста...', { chat_id: chatId, message_id: query.message.message_id });
    try {
      const user = await userData(chatId);
      if (!user || !user.tabs || !user.tabs[tabIndex]) {
        Logger.error(`Данные пользователя или вкладки не найдены`, { chatId, tabIndex });
        bot.sendMessage(chatId, 'Ошибка: данные вкладки не найдены. Попробуйте начать заново с /start.');
        return;
      }
      const selectedTab = user.tabs[tabIndex];
      Logger.info(`Запрос на скрейпинг`, { chatId, url: selectedTab.url });
      const response = await axios.post(`${process.env.SERVER_URL}/scrape`, {
        url: selectedTab.url,
        cookies: selectedTab.cookies || []
      });
      const { questions, combinedPrompt } = response.data;
      await userData(chatId, { ...user, questions });
      Logger.info(`Получены полные вопросы`, { chatId, url: selectedTab.url, questionCount: questions.length });
      Logger.info(`Запрос на обработку вопросов`, { chatId, questionCount: questions.length });
      const aiResponse = await axios.post(`${process.env.SERVER_URL}/process-questions`, {
        questions,
        combinedPrompt,
        model: 'deepseek/deepseek-r1:free'
      });
      const results = aiResponse.data.results;
      Logger.info(`Получены ответы от ИИ`, { chatId, resultCount: results.length });
      const QUESTIONS_PER_MESSAGE = 5;
      for (let i = 0; i < results.length; i += QUESTIONS_PER_MESSAGE) {
        let message = '';
        const endIndex = Math.min(i + QUESTIONS_PER_MESSAGE, results.length);
        for (let j = i; j < endIndex; j++) {
          const result = results[j];
          message += `Вопрос ${j + 1}: ${result.question}\n\n`;
          message += `<b>Ответ: ${result.answer.replace(/^Ответ \d+:\s*/, '')}</b>\n`;
          if (result.options && result.options.length) {
            message += `<blockquote expandable>Варианты:\n${result.options.map((opt, k) => `${k + 1}. ${opt}`).join('\n')}</blockquote>`;
          }
          message += '\n\n';
        }
        Logger.info(`Отправка вопросов ${i + 1}-${endIndex}`, { chatId, messageLength: message.length });
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      }
      bot.sendMessage(chatId, 'Все вопросы обработаны!');
    } catch (error) {
      Logger.error(`Ошибка обработки страницы`, { chatId, error: error.message, stack: error.stack });
      bot.sendMessage(chatId, `Ошибка: ${error.message}. Попробуй снова.`);
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