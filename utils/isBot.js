/**
 * Detects if the user agent is a search engine bot
 * 
 * @param {string} userAgent - The user agent string
 * @returns {boolean} - True if the user agent is a bot
 */
function isBot(userAgent) {
  if (!userAgent) return false;
  
  const botPatterns = [
    'googlebot',
    'bingbot',
    'yandexbot',
    'duckduckbot',
    'slurp',
    'baiduspider',
    'facebookexternalhit',
    'twitterbot',
    'rogerbot',
    'linkedinbot',
    'embedly',
    'quora link preview',
    'showyoubot',
    'outbrain',
    'pinterest',
    'slackbot',
    'vkshare',
    'w3c_validator',
    'lighthouse',
    'bot',
    'spider',
    'crawler'
  ];
  
  const lowerCaseUserAgent = userAgent.toLowerCase();
  
  return botPatterns.some(pattern => lowerCaseUserAgent.includes(pattern));
}

export default isBot; 