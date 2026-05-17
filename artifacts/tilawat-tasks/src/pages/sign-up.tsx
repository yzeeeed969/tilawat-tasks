import { useEffect } from "react";
import { useLocation } from "wouter";

export default function SignUpPage() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation("/sign-in"); }, [setLocation]);
  return null;
}
