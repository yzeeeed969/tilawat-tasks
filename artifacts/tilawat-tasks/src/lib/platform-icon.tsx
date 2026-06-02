import {
  FaYoutube,
  FaFacebook,
  FaInstagram,
  FaTwitter,
  FaTelegram,
  FaTiktok,
} from "react-icons/fa";
import { Smartphone } from "lucide-react";

interface PlatformIconProps {
  name?: string | null;
  icon?: string | null;
  className?: string;
}

export function PlatformIcon({ name, icon, className = "h-4 w-4" }: PlatformIconProps) {
  const key = String(icon ?? name ?? "").toLowerCase();

  if (key.includes("youtube") || key.includes("يوتيوب")) {
    return <FaYoutube className={`text-red-600 ${className}`} />;
  }
  if (key.includes("facebook") || key.includes("فيسبوك")) {
    return <FaFacebook className={`text-blue-600 ${className}`} />;
  }
  if (key.includes("instagram") || key.includes("إنستغرام") || key.includes("انستغرام")) {
    return <FaInstagram className={`text-pink-500 ${className}`} />;
  }
  if (key.includes("twitter") || key.includes("تويتر")) {
    return <FaTwitter className={`text-black ${className}`} />;
  }
  if (key.includes("telegram") || key.includes("تيليغرام") || key.includes("تلغرام") || key.includes("تلجرام") || key.includes("تلقرام")) {
    return <FaTelegram className={`text-sky-500 ${className}`} />;
  }
  if (key.includes("tiktok") || key.includes("تيك")) {
    return <FaTiktok className={`text-black ${className}`} />;
  }
  if (key.includes("app") || key.includes("تطبيق")) {
    return <Smartphone className={`text-emerald-700 ${className}`} />;
  }

  const appColors: Record<string, string> = {
    "haramain": "text-emerald-700",
    "yasser": "text-green-600",
    "maher": "text-green-600",
    "johani": "text-amber-700",
    "baleela": "text-orange-600",
  };

  const colorClass =
    Object.entries(appColors).find(([k]) => key.includes(k))?.[1] ??
    "text-muted-foreground";

  return <Smartphone className={`${colorClass} ${className}`} />;
}

export function getPlatformEmoji(name?: string | null, icon?: string | null): string {
  const key = String(icon ?? name ?? "").toLowerCase();
  if (key.includes("youtube") || key.includes("يوتيوب")) return "🎬";
  if (key.includes("facebook") || key.includes("فيسبوك")) return "📘";
  if (key.includes("instagram") || key.includes("إنستغرام") || key.includes("انستغرام")) return "📸";
  if (key.includes("twitter") || key.includes("تويتر")) return "🐦";
  if (key.includes("telegram") || key.includes("تيليغرام") || key.includes("تلغرام") || key.includes("تلجرام") || key.includes("تلقرام")) return "✈️";
  if (key.includes("tiktok") || key.includes("تيك")) return "🎵";
  if (key.includes("haramain") || key.includes("الحرمين")) return "🕌";
  if (key.includes("yasser") || key.includes("ياسر") || key.includes("maher") || key.includes("ماهر")) return "📱";
  if (key.includes("johani") || key.includes("الجهني")) return "📱";
  if (key.includes("baleela") || key.includes("بليلة")) return "📱";
  return "📱";
}
