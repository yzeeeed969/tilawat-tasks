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
