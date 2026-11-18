/**
 * Claude wrapper. Every call forces a single tool so output is structured,
 * never JSON scraped out of free text.
 */
const sdk = require('@anthropic-ai/sdk');

const Anthropic = sdk.default || sdk.Anthropic || sdk;

function createLlm({ apiKey }) {
  const client = apiKey ? new Anthropic({ apiKey }) : null;
  return {
    available: Boolean(client),
    async callTool({ model, system, messages, tool, maxTokens = 1200 }) {
      if (!client) throw new Error('ANTHROPIC_API_KEY is not set');
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
      });
      const block = (res.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
      if (!block) throw new Error('Model did not return the ' + tool.name + ' tool call');
      return { input: block.input, usage: res.usage };
    },
  };
}

module.exports = { createLlm };
