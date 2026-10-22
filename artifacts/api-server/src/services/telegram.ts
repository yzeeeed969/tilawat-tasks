export type TelegramSendResult = {
  ok: boolean;
  error?: string;
};

function getTelegramToken() {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

export function isTelegramConfigured() {
  return getTelegramToken().length > 0;
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  options: { replyMarkup?: unknown } = {},
): Promise<TelegramSendResult> {
  const token = getTelegramToken();
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      }),
    });
    const body = await res.json().catch(() => ({})) as { ok?: boolean; description?: string };

    if (!res.ok || body?.ok === false) {
      return {
        ok: false,
        error: typeof body?.description === "string" ? body.description : `Telegram HTTP ${res.status}`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Telegram request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

// استدعاء عام لـ Telegram Bot API (للقراءة/الإعداد مثل getWebhookInfo وsetWebhook) — مع مهلة.
export async function callTelegramApi<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: T; error?: string }> {
  const token = getTelegramToken();
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(params),
    });
    const body = await res.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || body?.ok === false) {
      return { ok: false, error: typeof body?.description === "string" ? body.description : `Telegram HTTP ${res.status}` };
    }
    return { ok: true, result: body.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Telegram request failed" };
  } finally {
    clearTimeout(timeout);
  }
}

// إرسال ملف صوتي برفعه (multipart) — حتى 50MB — باسم ملف ونص مرافق.
export async function sendTelegramAudioUpload(input: { chatId: string; file: Blob; fileName: string; caption: string; captionEntities?: unknown[] }): Promise<{ ok: boolean; result?: any; error?: string }> {
  const token = getTelegramToken();
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured" };
  const form = new FormData();
  form.append("chat_id", input.chatId);
  form.append("caption", input.caption);
  if (input.captionEntities?.length) form.append("caption_entities", JSON.stringify(input.captionEntities));
  form.append("audio", input.file, input.fileName);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, { method: "POST", body: form, signal: controller.signal });
    const body = await res.json().catch(() => ({})) as { ok?: boolean; result?: any; description?: string };
    if (!res.ok || body?.ok === false) return { ok: false, error: body?.description ?? `Telegram HTTP ${res.status}` };
    return { ok: true, result: body.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Telegram request failed" };
  } finally {
    clearTimeout(timeout);
  }
}
