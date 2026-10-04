import { providerForModel, SMALL_MODELS, type Effort, type Provider } from '@shared/models';
import type { SettingsStore } from '../settings';
import { AnthropicCompletionClient, AnthropicConversation, createAnthropicClient } from './anthropic';
import { CodexAuthedConversation, createCodexOpenAIClient, ensureFreshCodexSession } from './codex_auth';
import { createOpenAIClient, OpenAICompletionClient, OpenAIConversation } from './openai';
import { chooseOpenAIRoute, codexResponsesBaseUrl } from './openai_route';
import { OpenAIResponsesConversation } from './openai_responses';
import {
  MissingApiKeyError,
  type CompactionState,
  type CompletionClient,
  type Conversation,
  type SerializedConversation,
} from './types';

import { testEndpoint } from './endpoints';

export * from './types';

// End-to-end tests point the app at a local mock API; packaged builds ignore it (endpoints.ts, #64). The OpenAI one is
// only used when no custom base URL is set in settings, so the Responses API path can be tested.
const testAnthropicUrl = () => testEndpoint('PATCH_TEST_ANTHROPIC_URL');
const testOpenAIUrl = () => testEndpoint('PATCH_TEST_OPENAI_URL');

// Requests that are not part of a chat turn (titles) retry silently inside the SDK. Chat turns are retried by the
// agent loop instead, where the retry can be shown.
const BACKGROUND_RETRIES = 3;

// Creates conversations and small-model clients from the current settings and keys.
export class LlmService {
  constructor(private readonly settings: SettingsStore) {}

  createConversation(model = this.settings.get().model, effort = this.settings.get().effort): Conversation {
    return this.build(model, [], this.defaultOpenAIApi(), null, effort);
  }

  restoreConversation(saved: SerializedConversation, effort = this.settings.get().effort): Conversation {
    return this.build(saved.model, saved.messages, saved.api ?? 'chat', saved.compaction ?? null, effort);
  }

  // Prefers the pinned conversation's provider; falls back to whichever provider has a key.
  // Custom endpoints use the conversation model rather than assuming they serve OpenAI's small model.
  smallModel(conversation: Conversation): CompletionClient | null {
    const customEndpoint =
      conversation.provider === 'openai' && conversation.serialize().api === 'chat'
        ? this.settings.get().openaiBaseUrl.trim()
        : '';
    return this.smallModelFor(conversation.provider, customEndpoint, conversation.model);
  }

  // For work outside a chat (commit messages): the provider of the model in settings is preferred.
  smallModelForSettings(): CompletionClient | null {
    const { model, openaiBaseUrl } = this.settings.get();
    const provider = providerForModel(model);
    return this.smallModelFor(provider, provider === 'openai' ? openaiBaseUrl.trim() : '', model);
  }

  private smallModelFor(preferred: Provider, customEndpoint: string, customModel: string): CompletionClient | null {
    const order = preferred === 'anthropic' ? (['anthropic', 'openai'] as const) : (['openai', 'anthropic'] as const);
    for (const provider of order) {
      if (provider === 'anthropic') {
        const key = this.settings.getSecret('anthropicApiKey');
        if (key)
          return new AnthropicCompletionClient(
            createAnthropicClient(key, testAnthropicUrl(), BACKGROUND_RETRIES),
            SMALL_MODELS.anthropic,
          );
      } else {
        const key = this.settings.getSecret('openaiApiKey');
        if (key) {
          return new OpenAICompletionClient(
            createOpenAIClient(key, customEndpoint || testOpenAIUrl(), BACKGROUND_RETRIES),
            customEndpoint ? customModel : SMALL_MODELS.openai,
          );
        }
      }
    }
    return null;
  }

  // OpenAI's own API gets the Responses API; custom OpenAI-compatible endpoints usually only implement Chat Completions.
  private defaultOpenAIApi(): 'chat' | 'responses' {
    return this.settings.get().openaiBaseUrl.trim() ? 'chat' : 'responses';
  }

  private build(
    model: string,
    messages: unknown[],
    openaiApi: 'chat' | 'responses',
    compaction: CompactionState | null = null,
    effort: Effort = this.settings.get().effort,
  ): Conversation {
    const settings = this.settings.get();
    if (providerForModel(model) === 'anthropic') {
      const key = this.settings.getSecret('anthropicApiKey');
      if (!key) throw new MissingApiKeyError('anthropic');
      return new AnthropicConversation(createAnthropicClient(key, testAnthropicUrl()), {
        model,
        effort,
        messages: messages as never,
        compaction,
      });
    }
    const key = this.settings.getSecret('openaiApiKey');
    if (openaiApi === 'chat') {
      if (!key) throw new MissingApiKeyError('openai');
      return new OpenAIConversation(
        createOpenAIClient(key, settings.openaiBaseUrl || testOpenAIUrl()),
        model,
        messages as never,
        compaction,
      );
    }
    const route = chooseOpenAIRoute({
      openaiBaseUrl: settings.openaiBaseUrl,
      apiKey: key,
      session: this.settings.getChatGptSession(),
      codexBaseUrl: codexResponsesBaseUrl(),
    });
    // A custom base URL stays on that URL with the API key, including for a restored Responses history.
    if (route.kind === 'codex' && !settings.openaiBaseUrl.trim()) {
      const tokens = { accessToken: route.accessToken, accountId: route.accountId };
      const client = createCodexOpenAIClient(route.baseUrl, {
        accessToken: () => tokens.accessToken,
        accountId: () => tokens.accountId,
      });
      const inner = new OpenAIResponsesConversation(client, model, effort, messages as never, compaction);
      return new CodexAuthedConversation(inner, async () => {
        const fresh = await ensureFreshCodexSession(this.settings);
        tokens.accessToken = fresh.accessToken;
        tokens.accountId = fresh.accountId;
      });
    }
    if (!key) throw new MissingApiKeyError('openai');
    return new OpenAIResponsesConversation(
      createOpenAIClient(key, settings.openaiBaseUrl || testOpenAIUrl()),
      model,
      effort,
      messages as never,
      compaction,
    );
  }
}
