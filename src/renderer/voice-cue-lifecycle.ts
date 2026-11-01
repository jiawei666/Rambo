import type { VoiceState } from '../shared/contracts';
import type { VoiceCue } from './voice-cues';

export class VoiceCueLifecycle {
  private connectedChatId: string | null = null;

  onVoiceState(chatId: string, state: VoiceState): VoiceCue | null {
    if (state === 'live') {
      if (this.connectedChatId === chatId) return null;
      this.connectedChatId = chatId;
      return 'connected';
    }
    if (state === 'error' && this.connectedChatId === chatId) {
      this.connectedChatId = null;
      return 'ended';
    }
    return null;
  }

  onStopFinished(chatId: string): VoiceCue | null {
    if (this.connectedChatId !== chatId) return null;
    this.connectedChatId = null;
    return 'ended';
  }
}
