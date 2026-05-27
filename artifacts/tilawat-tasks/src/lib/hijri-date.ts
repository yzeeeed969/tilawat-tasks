import { useEffect, useState } from "react";

const HIJRI_PREF_KEY = "showHijriDate";
const HIJRI_PREF_EVENT = "tilawat:hijri-date-pref";

export function formatHijriDate(date: Date | string | number | null | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!date) return "";
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "";

  return new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura", {
    timeZone: "Asia/Riyadh",
    day: "numeric",
    month: "long",
    year: "numeric",
    ...options,
  }).format(value);
}

function readShowHijriPreference() {
  try {
    const stored = localStorage.getItem(HIJRI_PREF_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

export function useHijriPreference() {
  const [showHijri, setShowHijriState] = useState(readShowHijriPreference);

  const setShowHijri = (value: boolean) => {
    setShowHijriState(value);
    try {
      localStorage.setItem(HIJRI_PREF_KEY, String(value));
      window.dispatchEvent(new Event(HIJRI_PREF_EVENT));
    } catch {
      // Keep the in-memory state even if localStorage is unavailable.
    }
  };

  useEffect(() => {
    const sync = () => setShowHijriState(readShowHijriPreference());
    window.addEventListener("storage", sync);
    window.addEventListener(HIJRI_PREF_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(HIJRI_PREF_EVENT, sync);
    };
  }, []);

  return {
    showHijri,
    setShowHijri,
    toggleHijri: () => setShowHijri(!showHijri),
  };
}
