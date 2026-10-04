// قالب النشر الثابت (قارئ ← منصة ← نوع تصوير ← عضو): استيراد القالب الأولي بمطابقة أسماء مرنة
// لكن بلا تخمين أبدًا، وإدارة صفوفه (إضافة/تعديل/حذف) للمدير فقط.

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  recitersTable,
  membersTable,
  platformsTable,
  platformPagesTable,
  reciterPublishingTemplatesTable,
  weeklyScheduleSettingsTable,
} from "@workspace/db";

export class TemplateError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export type FilmingType = "affairs" | "tv";
type PlatformKey = "app" | "own_app" | "telegram" | "youtube" | "facebook";
type SeedRow = { platform: PlatformKey; type?: FilmingType; member: string };
type SeedReciter = { mosque: "haram" | "nabawi"; reciter: string; rows: SeedRow[] };

// ── القالب الأولي كما أرسله المدير (أسماء فقط — تُربط بالسجلات الفعلية في شاشة الاستيراد) ──────────
const app = (member: string): SeedRow => ({ platform: "app", member });
const own = (member: string): SeedRow => ({ platform: "own_app", member });
const tg = (member: string): SeedRow => ({ platform: "telegram", member });
const yt = (type: FilmingType, member: string): SeedRow => ({ platform: "youtube", type, member });
const fb = (type: FilmingType, member: string): SeedRow => ({ platform: "facebook", type, member });

export const TEMPLATE_SEED: SeedReciter[] = [
  { mosque: "haram", reciter: "ماهر المعيقلي", rows: [app("رهاف"), own("رهاف"), tg("لينا"), yt("tv", "شيخة"), fb("tv", "شيخة")] },
  { mosque: "haram", reciter: "ياسر الدوسري", rows: [app("هند محمد"), own("هند محمد"), yt("affairs", "شيخة"), yt("tv", "شيخة"), fb("affairs", "نورة"), fb("tv", "شيخة")] },
  { mosque: "haram", reciter: "بندر بليلة", rows: [app("عائشة سيد"), own("عائشة سيد"), tg("عائشة سيد"), yt("affairs", "ريم الخنين"), yt("tv", "يزيد"), fb("affairs", "شيخة"), fb("tv", "يزيد")] },
  { mosque: "haram", reciter: "بدر التركي", rows: [app("هند محمد"), tg("تقوى"), yt("affairs", "تقوى"), yt("tv", "يزيد"), fb("affairs", "شيخة"), fb("tv", "يزيد")] },
  { mosque: "haram", reciter: "عبدالله الجهني", rows: [app("شيخة"), own("شيخة"), tg("أحلام"), yt("affairs", "ناصر"), yt("tv", "يزيد"), fb("affairs", "شيخة"), fb("tv", "يزيد")] },
  { mosque: "haram", reciter: "عبدالرحمن السديس", rows: [app("شيخة"), tg("شيخة"), yt("affairs", "شيخة"), yt("tv", "شيخة")] },
  { mosque: "haram", reciter: "الوليد الشمسان", rows: [app("شيخة"), tg("مروج"), yt("affairs", "مروج"), yt("tv", "شيخة"), fb("affairs", "شيخة"), fb("tv", "شيخة")] },
  { mosque: "haram", reciter: "فيصل الغزاوي", rows: [app("شيخة")] },
  { mosque: "haram", reciter: "أسامة خياط", rows: [app("هند محمد")] },
  { mosque: "haram", reciter: "صالح بن حميد", rows: [app("هند محمد")] },
  { mosque: "nabawi", reciter: "عبدالله القرافي", rows: [app("هند محمد"), tg("هند محمد"), yt("tv", "يزيد"), fb("tv", "يزيد")] },
  { mosque: "nabawi", reciter: "أحمد الحذيفي", rows: [app("شيخة"), tg("شيخة"), yt("tv", "شيخة")] },
  { mosque: "nabawi", reciter: "عبدالمحسن القاسم", rows: [app("هند محمد")] },
  { mosque: "nabawi", reciter: "صالح المغامسي", rows: [app("العمري")] },
  { mosque: "nabawi", reciter: "عبدالباري الثبيتي", rows: [app("شيخة")] },
  { mosque: "nabawi", reciter: "عبدالله البعيجان", rows: [app("عائشة سيد")] },
  { mosque: "nabawi", reciter: "علي الحذيفي", rows: [app("هند محمد")] },
  { mosque: "nabawi", reciter: "حسين آل الشيخ", rows: [app("شيخة")] },
  { mosque: "nabawi", reciter: "خالد المهنا", rows: [app("شيخة")] },
  { mosque: "nabawi", reciter: "محمد برهجي", rows: [app("هند محمد")] },
  { mosque: "nabawi", reciter: "صلاح البدير", rows: [app("شيخة")] },
];

// ── تطبيع الأسماء للمقارنة (لا يغيّر أي اسم مخزَّن) ─────────────────────────────────────────────
export function normalizeName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, "") // تشكيل + تطويل
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .toLowerCase()
    .replace(/\s+/g, "") // «عبدالله» = «عبد الله»
    .trim();
}

function tokensOf(value: unknown) {
  return String(value ?? "")
    .split(/\s+/)
    .map((token) => normalizeName(token))
    .filter((token) => token.length >= 2);
}

const PLATFORM_ALIASES: Record<"telegram" | "youtube" | "facebook", string[]> = {
  telegram: ["تلقرام", "تليقرام", "تيليقرام", "تلغرام", "تيليغرام", "تيلغرام", "تليجرام", "تيليجرام", "تلجرام", "telegram"],
  youtube: ["يوتيوب", "يوتوب", "youtube"],
  facebook: ["فيسبوك", "فيس بوك", "فيسبوك", "facebook"],
};

export function isYoutubeOrFacebookName(name: string) {
  const n = normalizeName(name);
  return [...PLATFORM_ALIASES.youtube, ...PLATFORM_ALIASES.facebook].some((alias) => n.includes(normalizeName(alias)));
}

function isExcludedPlatformName(name: string) {
  return /twitter|تويتر|instagram|انستقرام|انستغرام|إنستقرام|إنستغرام|انستا/i.test(name);
}

// ── المطابقة: «مطابق» فقط عند تطابق تام بعد التطبيع ولمرشّح واحد؛ غير ذلك «اقتراح» أو «غامض» أو «غير موجود» ──
type Candidate = { id: number; name: string };
export type MatchStatus = "exact" | "suggested" | "ambiguous" | "missing";
export type EntityMatch = { key: string; label: string; status: MatchStatus; matchId: number | null; candidates: Candidate[] };

function matchByName(label: string, records: Candidate[]): Omit<EntityMatch, "key" | "label"> {
  const target = normalizeName(label);
  const exact = records.filter((r) => normalizeName(r.name) === target);
  if (exact.length === 1) return { status: "exact", matchId: exact[0].id, candidates: exact };
  if (exact.length > 1) return { status: "ambiguous", matchId: null, candidates: exact };

  // اقتراحات (لا تُعتمد تلقائيًا أبدًا): كل كلمات الاسم المُدخل موجودة في اسم السجل أو العكس.
  const labelTokens = tokensOf(label);
  const suggestions = records.filter((r) => {
    const recordTokens = tokensOf(r.name);
    if (labelTokens.length === 0 || recordTokens.length === 0) return false;
    const recordJoined = normalizeName(r.name);
    return labelTokens.every((t) => recordTokens.includes(t) || recordJoined.includes(t))
      || recordTokens.every((t) => labelTokens.includes(t));
  });
  if (suggestions.length === 1) return { status: "suggested", matchId: null, candidates: suggestions };
  if (suggestions.length > 1) return { status: "ambiguous", matchId: null, candidates: suggestions };
  return { status: "missing", matchId: null, candidates: [] };
}

export async function buildImportPreview() {
  const reciters = await db.select({ id: recitersTable.id, name: recitersTable.name, mosque: recitersTable.mosque }).from(recitersTable).orderBy(recitersTable.id);
  const members = await db.select({ id: membersTable.id, name: membersTable.name, isActive: membersTable.isActive }).from(membersTable).orderBy(membersTable.id);
  const platforms = await db.select({ id: platformsTable.id, name: platformsTable.name, coversAllReciters: platformsTable.coversAllReciters }).from(platformsTable).orderBy(platformsTable.id);

  const reciterMatches: EntityMatch[] = TEMPLATE_SEED.map((seed) => ({ key: seed.reciter, label: seed.reciter, ...matchByName(seed.reciter, reciters) }));

  const memberNames = [...new Set(TEMPLATE_SEED.flatMap((seed) => seed.rows.map((row) => row.member)))];
  const memberMatches: EntityMatch[] = memberNames.map((name) => ({ key: name, label: name, ...matchByName(name, members) }));

  const usable = platforms.filter((p) => !isExcludedPlatformName(p.name));
  const platformMatches: EntityMatch[] = [];
  // تطبيق الحرمين = المنصة المعلَّمة «تشمل كل القرّاء» (علَم صريح، لا اسم).
  const coversAll = usable.filter((p) => p.coversAllReciters);
  platformMatches.push({
    key: "app",
    label: "تطبيق تلاوات الحرمين",
    status: coversAll.length === 1 ? "exact" : coversAll.length > 1 ? "ambiguous" : "missing",
    matchId: coversAll.length === 1 ? coversAll[0].id : null,
    candidates: coversAll,
  });
  for (const key of ["telegram", "youtube", "facebook"] as const) {
    const aliases = PLATFORM_ALIASES[key].map(normalizeName);
    const exact = usable.filter((p) => aliases.includes(normalizeName(p.name)));
    const loose = exact.length > 0 ? exact : usable.filter((p) => aliases.some((alias) => normalizeName(p.name).includes(alias)));
    const label = key === "telegram" ? "تلقرام" : key === "youtube" ? "يوتيوب" : "فيسبوك";
    platformMatches.push({
      key,
      label,
      status: exact.length === 1 ? "exact" : exact.length > 1 ? "ambiguous" : loose.length === 1 ? "suggested" : loose.length > 1 ? "ambiguous" : "missing",
      matchId: exact.length === 1 ? exact[0].id : null,
      candidates: loose,
    });
  }
  // التطبيق الخاص لكل قارئ: منصة منفصلة. لا تطابق اسمي تام متوقَّع، فتبقى «اقتراحًا» يحتاج اعتمادًا.
  for (const seed of TEMPLATE_SEED) {
    if (!seed.rows.some((row) => row.platform === "own_app")) continue;
    const nameTokens = tokensOf(seed.reciter).filter((t) => t !== normalizeName("عبد") && t !== normalizeName("ال"));
    const candidates = usable.filter((p) => {
      if (p.coversAllReciters) return false;
      const n = normalizeName(p.name);
      return nameTokens.some((t) => t.length >= 4 && n.includes(t));
    });
    platformMatches.push({
      key: `own_app:${seed.reciter}`,
      label: `التطبيق الخاص — ${seed.reciter}`,
      status: candidates.length === 1 ? "suggested" : candidates.length > 1 ? "ambiguous" : "missing",
      matchId: null,
      candidates,
    });
  }

  const [settings] = await db.select().from(weeklyScheduleSettingsTable).limit(1);
  const existingRows = await db.select({ c: sql<number>`count(*)::int` }).from(reciterPublishingTemplatesTable);

  return {
    reciters: reciterMatches,
    members: memberMatches,
    platforms: platformMatches,
    allReciters: reciters,
    allMembers: members,
    allPlatforms: usable.map((p) => ({ id: p.id, name: p.name })),
    seedRowCount: TEMPLATE_SEED.reduce((sum, seed) => sum + seed.rows.length, 0),
    templateImportedAt: settings?.templateImportedAt ?? null,
    existingTemplateRows: existingRows[0]?.c ?? 0,
  };
}

// mapping: لكل كيان معرّف السجل المختار، أو null = «تخطٍّ» صريح. أي كيان بلا قرار ⇐ رفض كامل.
export async function applyImport(mapping: {
  reciters: Record<string, number | null>;
  members: Record<string, number | null>;
  platforms: Record<string, number | null>;
}) {
  const preview = await buildImportPreview();
  const missingDecisions = [
    ...preview.reciters.filter((m) => !(m.key in (mapping.reciters ?? {}))).map((m) => m.label),
    ...preview.members.filter((m) => !(m.key in (mapping.members ?? {}))).map((m) => m.label),
    ...preview.platforms.filter((m) => !(m.key in (mapping.platforms ?? {}))).map((m) => m.label),
  ];
  if (missingDecisions.length > 0) {
    throw new TemplateError(400, "decisions_required", `حدّد السجل أو «تخطٍّ» لكل اسم: ${missingDecisions.slice(0, 5).join("، ")}${missingDecisions.length > 5 ? "…" : ""}`);
  }

  const reciterIds = new Set(preview.allReciters.map((r) => r.id));
  const memberIds = new Set(preview.allMembers.map((m) => m.id));
  const platformIds = new Set(preview.allPlatforms.map((p) => p.id));
  const check = (value: number | null, ids: Set<number>, label: string) => {
    if (value === null) return null;
    const id = Number(value);
    if (!Number.isInteger(id) || !ids.has(id)) throw new TemplateError(400, "invalid_record", `سجل غير صالح لـ «${label}»`);
    return id;
  };

  type Row = { reciterId: number; platformId: number; filmingType: FilmingType | null; memberId: number; sortOrder: number };
  const rows: Row[] = [];
  const skipped: Array<{ reciter: string; platform: string; reason: string }> = [];
  for (const seed of TEMPLATE_SEED) {
    const reciterId = check(mapping.reciters[seed.reciter], reciterIds, seed.reciter);
    seed.rows.forEach((row, index) => {
      const platformKey = row.platform === "own_app" ? `own_app:${seed.reciter}` : row.platform;
      const platformLabel = preview.platforms.find((p) => p.key === platformKey)?.label ?? platformKey;
      if (reciterId === null) { skipped.push({ reciter: seed.reciter, platform: platformLabel, reason: "القارئ متخطّى" }); return; }
      const platformId = check(mapping.platforms[platformKey], platformIds, platformLabel);
      if (platformId === null) { skipped.push({ reciter: seed.reciter, platform: platformLabel, reason: "المنصة متخطّاة" }); return; }
      const memberId = check(mapping.members[row.member], memberIds, row.member);
      if (memberId === null) { skipped.push({ reciter: seed.reciter, platform: platformLabel, reason: `العضو «${row.member}» متخطّى` }); return; }
      rows.push({ reciterId, platformId, filmingType: row.type ?? null, memberId, sortOrder: index });
    });
  }

  let inserted = 0;
  let updated = 0;
  await db.transaction(async (tx: any) => {
    for (const row of rows) {
      const pageId = await reciterPageOn(tx, row.reciterId, row.platformId);
      const existing = await tx.execute(sql`
        SELECT id FROM reciter_publishing_templates
        WHERE reciter_id = ${row.reciterId} AND platform_id = ${row.platformId} AND coalesce(filming_type, '') = ${row.filmingType ?? ""}
        LIMIT 1
      `);
      const existingRows = (Array.isArray(existing) ? existing : existing?.rows ?? []) as Array<{ id: number }>;
      if (existingRows.length > 0) {
        await tx.update(reciterPublishingTemplatesTable)
          .set({ memberId: row.memberId, pageId, sortOrder: row.sortOrder, isActive: true, updatedAt: new Date() })
          .where(eq(reciterPublishingTemplatesTable.id, existingRows[0].id));
        updated += 1;
      } else {
        await tx.insert(reciterPublishingTemplatesTable).values({ ...row, pageId });
        inserted += 1;
      }
    }
    const [settings] = await tx.select().from(weeklyScheduleSettingsTable).limit(1);
    if (settings) {
      await tx.update(weeklyScheduleSettingsTable).set({ templateImportedAt: new Date(), updatedAt: new Date() }).where(eq(weeklyScheduleSettingsTable.id, settings.id));
    } else {
      await tx.insert(weeklyScheduleSettingsTable).values({ templateImportedAt: new Date() });
    }
  });
  return { inserted, updated, skipped };
}

// صفحة القارئ على المنصة إن وُجدت واحدة فقط (لربط المهام بالصفحة الصحيحة). غير ذلك: بلا صفحة.
async function reciterPageOn(client: any, reciterId: number, platformId: number) {
  const pages = await client
    .select({ id: platformPagesTable.id })
    .from(platformPagesTable)
    .where(and(eq(platformPagesTable.reciterId, reciterId), eq(platformPagesTable.platformId, platformId)));
  return pages.length === 1 ? pages[0].id as number : null;
}

// ── إدارة صفوف القالب ───────────────────────────────────────────────────────────────────────
export async function listTemplate() {
  const rows = await db
    .select({
      id: reciterPublishingTemplatesTable.id,
      reciterId: reciterPublishingTemplatesTable.reciterId,
      platformId: reciterPublishingTemplatesTable.platformId,
      filmingType: reciterPublishingTemplatesTable.filmingType,
      memberId: reciterPublishingTemplatesTable.memberId,
      pageId: reciterPublishingTemplatesTable.pageId,
      sortOrder: reciterPublishingTemplatesTable.sortOrder,
      isActive: reciterPublishingTemplatesTable.isActive,
      platformName: platformsTable.name,
      memberName: membersTable.name,
      memberActive: membersTable.isActive,
    })
    .from(reciterPublishingTemplatesTable)
    .innerJoin(platformsTable, eq(reciterPublishingTemplatesTable.platformId, platformsTable.id))
    .innerJoin(membersTable, eq(reciterPublishingTemplatesTable.memberId, membersTable.id))
    .orderBy(reciterPublishingTemplatesTable.reciterId, reciterPublishingTemplatesTable.sortOrder, reciterPublishingTemplatesTable.id);
  const reciters = await db.select({ id: recitersTable.id, name: recitersTable.name, mosque: recitersTable.mosque }).from(recitersTable).orderBy(recitersTable.id);
  const members = await db.select({ id: membersTable.id, name: membersTable.name, isActive: membersTable.isActive }).from(membersTable).orderBy(membersTable.id);
  const platforms = (await db.select({ id: platformsTable.id, name: platformsTable.name, coversAllReciters: platformsTable.coversAllReciters }).from(platformsTable).orderBy(platformsTable.id))
    .filter((p) => !isExcludedPlatformName(p.name))
    .map((p) => ({ ...p, supportsFilmingType: isYoutubeOrFacebookName(p.name) }));
  const pages = await db.select({ id: platformPagesTable.id, name: platformPagesTable.name, platformId: platformPagesTable.platformId, reciterId: platformPagesTable.reciterId }).from(platformPagesTable).orderBy(platformPagesTable.id);
  const [settings] = await db.select().from(weeklyScheduleSettingsTable).limit(1);
  return { rows, reciters, members, platforms, pages, templateImportedAt: settings?.templateImportedAt ?? null };
}

async function validateRow(input: { reciterId: number; platformId: number; filmingType: FilmingType | null; memberId: number; pageId: number | null }) {
  const [reciter] = await db.select().from(recitersTable).where(eq(recitersTable.id, input.reciterId)).limit(1);
  if (!reciter) throw new TemplateError(400, "invalid_reciter", "القارئ غير موجود");
  const [platform] = await db.select().from(platformsTable).where(eq(platformsTable.id, input.platformId)).limit(1);
  if (!platform) throw new TemplateError(400, "invalid_platform", "المنصة غير موجودة");
  if (isExcludedPlatformName(platform.name)) throw new TemplateError(400, "excluded_platform", "تويتر وإنستقرام مستبعدان من القالب حاليًا");
  const [member] = await db.select().from(membersTable).where(eq(membersTable.id, input.memberId)).limit(1);
  if (!member) throw new TemplateError(400, "invalid_member", "العضو غير موجود");
  const supportsType = isYoutubeOrFacebookName(platform.name);
  if (!supportsType && input.filmingType) throw new TemplateError(400, "type_not_allowed", "نوع التصوير لمنصتي يوتيوب وفيسبوك فقط");
  if (supportsType && !input.filmingType) throw new TemplateError(400, "type_required", "حدّد نوع التصوير (الشؤون أو التلفزيون) لمنصة يوتيوب/فيسبوك");
  if (supportsType && reciter.mosque === "nabawi" && input.filmingType !== "tv") {
    throw new TemplateError(400, "nabawi_tv_only", "أئمة المسجد النبوي: يوتيوب وفيسبوك بنوع «تصوير التلفزيون» فقط");
  }
  if (input.pageId !== null) {
    const [page] = await db.select().from(platformPagesTable).where(eq(platformPagesTable.id, input.pageId)).limit(1);
    if (!page || page.platformId !== platform.id) throw new TemplateError(400, "invalid_page", "الصفحة لا تتبع هذه المنصة");
  }
  return { reciter, platform, member };
}

function parseFilmingType(value: unknown): FilmingType | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === "affairs" || value === "tv") return value;
  throw new TemplateError(400, "invalid_type", "نوع تصوير غير صالح");
}

function parseId(value: unknown, label: string) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TemplateError(400, "invalid_input", `${label} غير صالح`);
  return id;
}

export async function createTemplateRow(body: any) {
  const input = {
    reciterId: parseId(body?.reciterId, "القارئ"),
    platformId: parseId(body?.platformId, "المنصة"),
    filmingType: parseFilmingType(body?.filmingType),
    memberId: parseId(body?.memberId, "العضو"),
    pageId: body?.pageId ? parseId(body.pageId, "الصفحة") : null,
  };
  await validateRow(input);
  const duplicate = await db.execute(sql`
    SELECT id FROM reciter_publishing_templates
    WHERE reciter_id = ${input.reciterId} AND platform_id = ${input.platformId} AND coalesce(filming_type, '') = ${input.filmingType ?? ""}
    LIMIT 1
  `);
  if (((Array.isArray(duplicate) ? duplicate : (duplicate as any)?.rows) ?? []).length > 0) {
    throw new TemplateError(409, "duplicate_row", "يوجد صف لنفس القارئ والمنصة ونوع التصوير — عدّله بدل إضافة صف جديد");
  }
  const pageId = input.pageId ?? await reciterPageOn(db, input.reciterId, input.platformId);
  const [row] = await db.insert(reciterPublishingTemplatesTable).values({ ...input, pageId, sortOrder: 100 }).returning();
  return row;
}

export async function updateTemplateRow(id: number, body: any) {
  const [current] = await db.select().from(reciterPublishingTemplatesTable).where(eq(reciterPublishingTemplatesTable.id, id)).limit(1);
  if (!current) throw new TemplateError(404, "not_found", "الصف غير موجود");
  const next = {
    reciterId: current.reciterId,
    platformId: current.platformId,
    filmingType: "filmingType" in (body ?? {}) ? parseFilmingType(body.filmingType) : (current.filmingType as FilmingType | null),
    memberId: body?.memberId !== undefined ? parseId(body.memberId, "العضو") : current.memberId,
    pageId: "pageId" in (body ?? {}) ? (body.pageId ? parseId(body.pageId, "الصفحة") : null) : current.pageId,
  };
  await validateRow(next);
  if (next.filmingType !== current.filmingType) {
    const duplicate = await db.execute(sql`
      SELECT id FROM reciter_publishing_templates
      WHERE reciter_id = ${next.reciterId} AND platform_id = ${next.platformId} AND coalesce(filming_type, '') = ${next.filmingType ?? ""} AND id <> ${id}
      LIMIT 1
    `);
    if (((Array.isArray(duplicate) ? duplicate : (duplicate as any)?.rows) ?? []).length > 0) {
      throw new TemplateError(409, "duplicate_row", "يوجد صف آخر لنفس القارئ والمنصة ونوع التصوير");
    }
  }
  const [row] = await db.update(reciterPublishingTemplatesTable)
    .set({
      filmingType: next.filmingType,
      memberId: next.memberId,
      pageId: next.pageId,
      ...(typeof body?.isActive === "boolean" ? { isActive: body.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(reciterPublishingTemplatesTable.id, id))
    .returning();
  return row;
}

export async function deleteTemplateRow(id: number) {
  const deleted = await db.delete(reciterPublishingTemplatesTable).where(eq(reciterPublishingTemplatesTable.id, id)).returning({ id: reciterPublishingTemplatesTable.id });
  if (deleted.length === 0) throw new TemplateError(404, "not_found", "الصف غير موجود");
  return { deleted: deleted[0].id };
}

export async function activeTemplateRowsFor(reciterIds: number[]) {
  if (reciterIds.length === 0) return [];
  return db
    .select({
      id: reciterPublishingTemplatesTable.id,
      reciterId: reciterPublishingTemplatesTable.reciterId,
      platformId: reciterPublishingTemplatesTable.platformId,
      filmingType: reciterPublishingTemplatesTable.filmingType,
      memberId: reciterPublishingTemplatesTable.memberId,
      pageId: reciterPublishingTemplatesTable.pageId,
      sortOrder: reciterPublishingTemplatesTable.sortOrder,
      platformName: platformsTable.name,
      memberName: membersTable.name,
      memberActive: membersTable.isActive,
    })
    .from(reciterPublishingTemplatesTable)
    .innerJoin(platformsTable, eq(reciterPublishingTemplatesTable.platformId, platformsTable.id))
    .innerJoin(membersTable, eq(reciterPublishingTemplatesTable.memberId, membersTable.id))
    .where(and(inArray(reciterPublishingTemplatesTable.reciterId, reciterIds), eq(reciterPublishingTemplatesTable.isActive, true)))
    .orderBy(reciterPublishingTemplatesTable.reciterId, reciterPublishingTemplatesTable.sortOrder, reciterPublishingTemplatesTable.id);
}
