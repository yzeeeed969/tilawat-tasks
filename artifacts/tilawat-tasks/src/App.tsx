import { type ReactNode, useEffect } from "react";
import { Switch, Route, useLocation, Router as WouterRouter, useParams } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "@/components/layout";
import { AuthProvider, useAuth } from "@/lib/auth-context";

import Dashboard from "@/pages/dashboard";
import Tasks from "@/pages/tasks";
import Members from "@/pages/members";
import Reports from "@/pages/reports";
import Settings from "@/pages/settings";
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

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={HomeRoute} />
      <Route path="/sign-in" component={SignInPage} />
      <Route path="/reset-password" component={ResetPasswordPage} />
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
      <Route path="/settings">
        <ProtectedRoute>
          <AppLayout><Settings /></AppLayout>
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
