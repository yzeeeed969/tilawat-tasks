import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CheckSquare,
  Users,
  BarChart3,
  Settings,
  Bell,
  Repeat2,
  Link2,
  MessageSquare,
  Filter,
  Trash2,
  Copy,
  Moon,
  Sun,
  HelpCircle,
  Shield,
  Lock,
} from "lucide-react";

const sections = [
  {
    icon: CheckSquare,
    color: "text-blue-600",
    bg: "bg-blue-50",
    title: "صفحة المهام",
    items: [
      { label: "إضافة مهمة", desc: "اضغط على «مهمة جديدة» لإنشاء مهمة جديدة. اختر المنصة والصفحة والقارئ والعضو المسؤول." },
      { label: "تعديل المهمة", desc: "اضغط على قائمة ⋯ بجانب المهمة واختر «تعديل المهمة»." },
      { label: "تكرار المهمة", desc: "اضغط على ⋯ واختر «نسخ المهمة» لإنشاء نسخة منها بسهولة." },
      { label: "سلة المهام", desc: "عند الحذف تنتقل المهمة إلى السلة. افتح تبويب «السلة» لاستعادتها أو حذفها نهائياً." },
      { label: "بحث وفلترة", desc: "استخدم شريط البحث السريع للبحث في العناوين والمنصات والأعضاء. الفلاتر تشمل: المنصة، القارئ، العضو، الحالة، التاريخ." },
      { label: "رابط الشاهد", desc: "بعد إتمام مهمة أضف رابط المنشور أو المقطع كإثبات. يظهر للفريق كلّه." },
      { label: "التكرار التلقائي", desc: "عند إتمام مهمة متكررة (يومي/أسبوعي/شهري) يُنشئ النظام مهمة جديدة تلقائياً بنفس البيانات." },
    ],
  },
  {
    icon: Users,
    color: "text-emerald-600",
    bg: "bg-emerald-50",
    title: "صفحة الأعضاء",
    items: [
      { label: "إضافة حساب", desc: "اضغط «إضافة حساب» وأدخل الاسم واسم المستخدم وكلمة المرور والصلاحية." },
      { label: "صلاحيات", desc: "مدير: كامل الصلاحيات. محرر: تعديل المهام. متابع: عرض فقط وتحديث حالة مهامه." },
      { label: "تجميد الحساب", desc: "يمنع المستخدم من تسجيل الدخول مؤقتاً دون حذف البيانات." },
      { label: "تغيير كلمة المرور", desc: "يمكن للمدير تغيير كلمة مرور أي عضو من قائمة الإجراءات." },
      { label: "معدل الإنجاز", desc: "يُحسب تلقائياً من نسبة المهام المكتملة إلى إجمالي المهام لكل عضو." },
      { label: "تصدير Excel", desc: "اضغط «تصدير Excel» للحصول على ملف يحتوي بيانات وإحصاءات الأعضاء." },
      { label: "استيراد Excel", desc: "استيراد أعضاء دفعة واحدة من ملف Excel بالأعمدة: الاسم الكامل، اسم المستخدم، كلمة المرور، المسمى الوظيفي، الصلاحية." },
    ],
  },
  {
    icon: BarChart3,
    color: "text-purple-600",
    bg: "bg-purple-50",
    title: "صفحة التقارير",
    items: [
      { label: "الفترة الزمنية", desc: "اختر: اليوم / الأسبوع / الشهر / كل الوقت لعرض إحصاءات الفترة المختارة." },
      { label: "أداء الأعضاء", desc: "جدول يُظهر المهام المكتملة والمتأخرة والمنشأة لكل عضو في الفترة المختارة." },
      { label: "إحصاءات المنصات", desc: "جدول يُظهر أداء كل منصة اجتماعية: مكتمل / قيد التنفيذ / متأخر." },
      { label: "إحصاءات القراء", desc: "جدول يُظهر عدد المهام المرتبطة بكل قارئ ونسبة إنجازها." },
      { label: "نسخ واتساب", desc: "اضغط «نسخ الملخص» لنسخ تقرير منسق جاهز للإرسال على واتساب." },
      { label: "طباعة / PDF", desc: "اضغط «طباعة» لطباعة التقرير أو حفظه كـ PDF عبر خيار «حفظ كـ PDF» في نافذة الطباعة." },
    ],
  },
  {
    icon: Bell,
    color: "text-amber-600",
    bg: "bg-amber-50",
    title: "الإشعارات",
    items: [
      { label: "إشعارات المهام", desc: "تصلك إشعارات عند: إسناد مهمة لك، تعديل مهمة خاصة بك، أو اكتمال مهمة (للمديرين)." },
      { label: "تعليم كمقروء", desc: "اضغط ✓ بجانب الإشعار أو «قراءة الكل» لتعليم جميع الإشعارات كمقروءة." },
      { label: "الأرشيف", desc: "الإشعارات المحذوفة تنتقل إلى تبويب الأرشيف للرجوع إليها لاحقاً." },
      { label: "التحديث التلقائي", desc: "تتحدث الإشعارات تلقائياً كل 30 ثانية." },
    ],
  },
  {
    icon: Settings,
    color: "text-gray-600",
    bg: "bg-gray-50",
    title: "الإعدادات (للمديرين)",
    items: [
      { label: "المنصات", desc: "إضافة وتعديل وحذف المنصات الاجتماعية. يمكن تعيين منصة رئيسية وإدارة صفحاتها وربطها بقارئ." },
      { label: "القراء", desc: "إضافة القراء وتحديد مسجدهم (النبوي / الحرام). تُستخدم في تصنيف المهام." },
      { label: "إدارة المستخدمين", desc: "قبول الحسابات المعلقة، تغيير الصلاحيات، تجميد أو حذف الحسابات." },
    ],
  },
  {
    icon: Moon,
    color: "text-indigo-600",
    bg: "bg-indigo-50",
    title: "الوضع الليلي وإعدادات العرض",
    items: [
      { label: "تبديل الوضع", desc: "اضغط على أيقونة القمر/الشمس في أسفل الشريط الجانبي لتفعيل الوضع الليلي أو الإضاءة." },
      { label: "حفظ التفضيل", desc: "يُحفظ تفضيلك تلقائياً في المتصفح ويُطبَّق عند كل زيارة." },
    ],
  },
  {
    icon: Shield,
    color: "text-red-600",
    bg: "bg-red-50",
    title: "الأمان",
    items: [
      { label: "كلمة المرور", desc: "استخدم كلمة مرور قوية (8 أحرف على الأقل). يمكن للمدير تغييرها في أي وقت." },
      { label: "الجلسات", desc: "تسجيل الخروج يُنهي الجلسة الحالية فقط." },
      { label: "الحسابات المعلقة", desc: "الحسابات الجديدة تحتاج موافقة المدير قبل الاستخدام." },
    ],
  },
];

export default function Help() {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight flex items-center gap-3">
          <HelpCircle className="h-8 w-8 text-sidebar-primary" />
          دليل الاستخدام
        </h2>
        <p className="text-muted-foreground mt-2 text-lg">
          كل ما تحتاج لمعرفته عن استخدام نظام إدارة مهام تلاوة الحرمين
        </p>
      </div>

      {/* Quick tips banner */}
      <div className="bg-sidebar-primary/10 border border-sidebar-primary/20 rounded-xl p-5">
        <h3 className="font-bold text-sidebar-primary mb-3 flex items-center gap-2">
          <Lock className="h-4 w-4" />
          نصائح سريعة
        </h3>
        <ul className="space-y-2 text-sm text-foreground/80">
          <li className="flex items-start gap-2">
            <span className="text-sidebar-primary font-bold shrink-0">•</span>
            <span>لإتمام مهمة يجب إضافة رابط الشاهد أولاً (المنشور أو المقطع)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-sidebar-primary font-bold shrink-0">•</span>
            <span>المهام المتأخرة تظهر بخلفية حمراء خفيفة في قائمة المهام</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-sidebar-primary font-bold shrink-0">•</span>
            <span>يمكن تعيين قارئ تلقائياً للمهمة عند اختيار صفحة مرتبطة بقارئ</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-sidebar-primary font-bold shrink-0">•</span>
            <span>استخدم عرض «بالقارئ» في المهام لرؤية جميع مهام كل قارئ مجمّعة</span>
          </li>
        </ul>
      </div>

      {/* Sections grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {sections.map(({ icon: Icon, color, bg, title, items }) => (
          <Card key={title} className="border-border/50 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-3 text-lg">
                <div className={`p-2 rounded-lg ${bg}`}>
                  <Icon className={`h-5 w-5 ${color}`} />
                </div>
                {title}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {items.map(({ label, desc }) => (
                  <li key={label} className="flex gap-2.5">
                    <Badge
                      variant="outline"
                      className={`shrink-0 mt-0.5 text-[11px] font-semibold h-5 px-2 ${bg} ${color} border-current/20`}
                    >
                      {label}
                    </Badge>
                    <p className="text-sm text-muted-foreground leading-snug">{desc}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="text-center text-sm text-muted-foreground pb-4">
        نظام إدارة مهام تلاوة الحرمين — الإصدار 2.0
      </div>
    </div>
  );
}
