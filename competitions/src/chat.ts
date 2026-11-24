// The cup chat is the main chat window's Cup channel (mod/nsws_chat.js): the cup's own room on the
// site's chat server (proxy/src/chat.js, one per cup code), with everything the main chat has.
// Joining a cup switches the window to it; the player can switch back to Everyone.
import { site } from './game.ts';

interface MainChat {
  setCup?(room: { code: string; secret: string | null } | null): void;
  open?(): boolean;
  typing?(): boolean;
}
const mainChat = () => (window as unknown as { __nswsChat?: MainChat }).__nswsChat;

export class CupChat {
  #sent: string | null = null;
  constructor(private o: { context: () => { cupId: string; host: boolean } | null }) {}

  tick() {
    const chat = mainChat();
    if (!chat?.setCup) return;
    const room = this.o.context() ? (site.__nswsCupRoom?.() ?? null) : null;
    const key = room ? room.code + ' ' + (room.secret ?? '') : '';
    if (key === this.#sent) return;
    this.#sent = key;
    chat.setCup(room ? { code: room.code, secret: room.secret ?? null } : null);
  }

  open() {
    return !!mainChat()?.open?.();
  }

  get typing() {
    return !!mainChat()?.typing?.();
  }
}
