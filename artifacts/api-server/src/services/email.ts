import nodemailer from "nodemailer";
import { logger } from "../lib/logger";

export async function sendPasswordResetEmail(to: string, resetLink: string, displayName: string): Promise<boolean> {
  const transporter = createTransporter();
  if (!transporter) {
    logger.warn("Email not configured — reset link: " + resetLink);
    return false;
  }
  try {
    await transporter.sendMail({
      from: `"تلاوة الحرمين" <${process.env.GMAIL_USER}>`,
      to,
      subject: "إعادة تعيين كلمة المرور — تلاوة الحرمين",
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
          <h2 style="color:#1a5c3a;">تلاوة الحرمين</h2>
          <p>السلام عليكم ${displayName}،</p>
          <p>تلقينا طلباً لإعادة تعيين كلمة المرور. اضغط على الزر أدناه (صالح لمدة ساعة واحدة):</p>
          <a href="${resetLink}" style="display:inline-block;background:#1a5c3a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0;">
            إعادة تعيين كلمة المرور
          </a>
          <p style="color:#888;font-size:13px;">إذا لم تطلب ذلك، تجاهل هذه الرسالة.</p>
        </div>`,
    });
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to send reset email");
    return false;
  }
}

export async function sendWelcomeEmail(to: string, displayName: string, username: string, password: string): Promise<boolean> {
  const transporter = createTransporter();
  if (!transporter) {
    logger.warn(`Email not configured — would have sent welcome email to: ${to}`);
    return false;
  }
  try {
    await transporter.sendMail({
      from: `"تلاوة الحرمين" <${process.env.GMAIL_USER}>`,
      to,
      subject: "مرحباً بك في فريق تلاوة الحرمين",
      html: `
        <div dir="rtl" style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;">
          <h2 style="color:#1a5c3a;">مرحباً بك في تلاوة الحرمين 🎉</h2>
          <p>السلام عليكم ${displayName}،</p>
          <p>تمت إضافتك إلى فريق تلاوة الحرمين. بيانات دخولك:</p>
          <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0;">
            <p style="margin:4px 0;"><strong>اسم المستخدم:</strong> <span dir="ltr">${username}</span></p>
            <p style="margin:4px 0;"><strong>كلمة السر:</strong> <span dir="ltr">${password}</span></p>
          </div>
          <p style="color:#888;font-size:13px;">يُنصح بتغيير كلمة المرور من صفحة "حسابي" بعد أول تسجيل دخول.</p>
        </div>`,
    });
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to send welcome email");
    return false;
  }
}

function createTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

export async function sendOtpEmail(toEmail: string, code: string): Promise<boolean> {
  const transporter = createTransporter();

  if (!transporter) {
    logger.warn("Email not configured — GMAIL_USER or GMAIL_APP_PASSWORD missing. OTP code: " + code);
    return false;
  }

  const html = `
    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f9fafb; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="color: #1e293b; font-size: 22px; margin: 0;">تلاوة الحرمين</h1>
        <p style="color: #64748b; font-size: 14px; margin: 4px 0 0;">نظام إدارة مهام الفريق الإعلامي</p>
      </div>
      <div style="background: white; border-radius: 10px; padding: 28px; border: 1px solid #e2e8f0; text-align: center;">
        <p style="color: #374151; font-size: 16px; margin: 0 0 20px;">رمز التحقق الخاص بك للدخول إلى النظام:</p>
        <div style="background: #f1f5f9; border: 2px dashed #cbd5e1; border-radius: 10px; padding: 20px; margin: 0 auto 20px; display: inline-block;">
          <span style="font-size: 40px; font-weight: bold; letter-spacing: 10px; color: #1e293b; font-family: monospace;">${code}</span>
        </div>
        <p style="color: #6b7280; font-size: 13px; margin: 0;">صالح لمدة <strong>5 دقائق</strong> فقط</p>
        <p style="color: #9ca3af; font-size: 12px; margin: 12px 0 0;">إذا لم تطلب هذا الرمز، تجاهل هذا البريد</p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"تلاوة الحرمين" <${process.env.GMAIL_USER}>`,
      to: toEmail,
      subject: `${code} — رمز التحقق لنظام تلاوة الحرمين`,
      html,
    });
    return true;
  } catch (err) {
    logger.error({ err }, "Failed to send OTP email");
    return false;
  }
}
