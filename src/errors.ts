// Turn common model-call errors into something a new user can understand: no API key, wrong API key, not enough balance.
// The engine's raw message is in English and includes doc paths from node_modules and command-line usage like /login, which are no use in Kiki.

const SETTINGS = "click \"Settings → Providers\" in the bottom-left corner";

/** Recognized errors get a plain-English explanation; unrecognized ones are returned as-is. */
export function explainError(message: string): string {
  const missing = message.match(/No API key found for "?([\w-]+)"?|Provider is not configured: ([\w-]+)/);
  if (missing) {
    const provider = missing[1] ?? missing[2];
    if (provider.toLowerCase() === "deepseek")
      return `No model API key yet. ${SETTINGS}, choose DeepSeek and enter your API key (get one at https://platform.deepseek.com), then save and you're good to go.`;
    return `You're not signed in to ${provider} and no API key is set for it. ${SETTINGS} to add a ${provider} API key, or go to "Settings → Model" and switch to a model that's already configured.`;
  }
  if (/\b401\b|Authentication Fails|invalid[ _-]?api[ _-]?key|Incorrect API key|Unauthorized/i.test(message))
    return `The model API key is wrong or has expired. ${SETTINGS} to enter a new key and try again. (Original message: ${message.slice(0, 200)})`;
  if (/\b402\b|Insufficient Balance|insufficient_quota/i.test(message))
    return `Your model account balance is too low. Top up and try again. (Original message: ${message.slice(0, 200)})`;
  return message;
}
