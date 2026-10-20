import { type ReactNode, useEffect } from "react";
import { Switch, Route, useLocation, Router as WouterRouter, useParams } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/layout";
import { AuthProvider, useAuth } from "@/lib/auth-context";

import Tasks from "@/pages/tasks";
import Members from "@/pages/members";
import Reports from "@/pages/reports";
import {
  GeneralSettingsPage,
  TelegramSettingsPage,
} from "@/pages/settings";
import RecitersPage from "@/pages/reciters";
import PlatformsPage from "@/pages/platforms";
import YoutubeMonitorPage from "@/pages/youtube-monitor";
import PublishingTemplatePage from "@/pages/publishing-template";
import WeeklySchedulePage from "@/pages/weekly-schedule";
import TelegramMonitorPage from "@/pages/telegram-monitor";
import InstagramMonitorPage from "@/pages/instagram-monitor";
import CrosspostMonitorPage from "@/pages/crosspost-monitor";
import Account from "@/pages/account";
import Reminders from "@/pages/reminders";
import Achievements from "@/pages/achievements";
import SignInPage from "@/pages/sign-in";
import ResetPasswordPage from "@/pages/reset-password";
import Help from "@/pages/help";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (isLoaded && !isSignedIn) setLocation("/sign-in");
  }, [isLoaded, isSignedIn, setLocation]);

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sidebar">
        <div className="w-8 h-8 border-4 border-sidebar-primary/30 border-t-sidebar-primary rounded-full animate-spin" />
      </div>
    );
  }
  if (!isSignedIn) return null;
  return <>{children}</>;
}

function HomeRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) setLocation("/tasks");
    else setLocation("/sign-in");
  }, [isLoaded, isSignedIn, setLocation]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-sidebar">
      <div className="w-8 h-8 border-4 border-sidebar-primary/30 border-t-sidebar-primary rounded-full animate-spin" />
    </div>
  );
}

function TasksRoute({ taskId }: { taskId?: number }) {
  return (
    <ProtectedRoute>
      <AppLayout><Tasks taskId={taskId} /></AppLayout>
    </ProtectedRoute>
  );
}

function TaskLinkRoute() {
  const params = useParams<{ id: string }>();
  const parsedTaskId = params.id ? Number(params.id) : NaN;

  return <TasksRoute taskId={Number.isFinite(parsedTaskId) ? parsedTaskId : undefined} />;
}

// صفحة «كل إعدادات النظام» القديمة حُذفت (كانت تكرّر أربع صفحات). أي رابط قديم إليها يُحوَّل
// إلى الصفحة الأصلية المقابلة لقسمها، وإلا فإلى «المستخدمون والصلاحيات».
const LEGACY_SETTINGS_SECTIONS: Record<string, string> = {
  telegram: "/settings/telegram",
  general: "/settings/general",
  reciters: "/reciters",
  platforms: "/platforms",
};

function LegacySettingsRedirect() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    const section = window.location.hash.replace("#", "");
    setLocation(LEGACY_SETTINGS_SECTIONS[section] ?? "/settings/general", { replace: true });
  }, [setLocation]);

  return null;
}

// صفحة «توليد المهام» حُذفت (الإصدار 60) — الروابط القديمة تُحوَّل إلى المهام.
function TaskGenerationDisabledRoute() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation("/tasks", { replace: true });
  }, [setLocation]);

  return null;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={HomeRoute} />
      <Route path="/achievements" component={Achievements} />
      <Route path="/sign-in" component={SignInPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
      <Route path="/reset-password/:token" component={ResetPasswordPage} />
      <Route path="/tasks/:id" component={TaskLinkRoute} />
      <Route path="/tasks">
        <TasksRoute />
      </Route>
      <Route path="/members">
        <ProtectedRoute>
          <AppLayout><Members /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/reports">
        <ProtectedRoute>
          <AppLayout><Reports /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/settings/telegram">
        <ProtectedRoute>
          <AppLayout><TelegramSettingsPage /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/settings/general">
        <ProtectedRoute>
          <AppLayout><GeneralSettingsPage /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/settings">
        <LegacySettingsRedirect />
      </Route>
      <Route path="/reciters">
        <ProtectedRoute>
          <AppLayout><RecitersPage /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/platforms">
        <ProtectedRoute>
          <AppLayout><PlatformsPage /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/task-generation">
        <TaskGenerationDisabledRoute />
      </Route>
      <Route path="/weekly-schedule">
        <ProtectedRoute>
          <AppLayout><WeeklySchedulePage /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/publishing-template">
        <ProtectedRoute>
          <AppLayout><PublishingTemplatePage /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/telegram-monitor">
        <ProtectedRoute>
          <AppLayout><TelegramMonitorPage /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/crosspost-monitor">
        <ProtectedRoute>
          <AppLayout><CrosspostMonitorPage /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/instagram-monitor">
        <ProtectedRoute>
          <AppLayout><InstagramMonitorPage /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/youtube-monitor">
        <ProtectedRoute>
          <AppLayout><YoutubeMonitorPage /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/account">
        <ProtectedRoute>
          <AppLayout><Account /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/reminders">
        <ProtectedRoute>
          <AppLayout><Reminders /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route path="/help">
        <ProtectedRoute>
          <AppLayout><Help /></AppLayout>
        </ProtectedRoute>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <AuthProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AppRouter />
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </AuthProvider>
    </WouterRouter>
  );
}

export default App;
