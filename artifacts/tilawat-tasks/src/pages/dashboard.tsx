import { useGetStatsOverview, getGetStatsOverviewQueryKey, useGetMemberStats, getGetMemberStatsQueryKey, useGetPlatformStats, getGetPlatformStatsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Clock, CircleDashed, ListTodo, Users, BarChart3 } from "lucide-react";
import { PlatformIcon } from "@/lib/platform-icon";

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetStatsOverview({ query: { queryKey: getGetStatsOverviewQueryKey() } });
  const { data: memberStats, isLoading: membersLoading } = useGetMemberStats({ query: { queryKey: getGetMemberStatsQueryKey() } });
  const { data: platformStats, isLoading: platformsLoading } = useGetPlatformStats({ query: { queryKey: getGetPlatformStatsQueryKey() } });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h2 className="text-3xl font-bold text-foreground tracking-tight">لوحة القيادة</h2>
        <p className="text-muted-foreground mt-2 text-lg">نظرة عامة على أداء فريق تلاوة الحرمين</p>
      </div>

      {statsLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}
        </div>
      ) : stats ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card className="border-sidebar-primary/20 shadow-sm hover:shadow-md transition-all">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">إجمالي المهام</CardTitle>
              <ListTodo className="h-5 w-5 text-sidebar-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{stats.totalTasks}</div>
            </CardContent>
          </Card>
          
          <Card className="border-green-500/20 shadow-sm hover:shadow-md transition-all">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">المهام المكتملة</CardTitle>
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{stats.completedTasks}</div>
              <p className="text-xs text-muted-foreground mt-1">
                معدل الإنجاز {Math.round(stats.completionRate)}%
              </p>
            </CardContent>
          </Card>
          
          <Card className="border-amber-500/20 shadow-sm hover:shadow-md transition-all">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">قيد التنفيذ</CardTitle>
              <Clock className="h-5 w-5 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{stats.inProgressTasks}</div>
            </CardContent>
          </Card>
          
          <Card className="border-gray-400/20 shadow-sm hover:shadow-md transition-all">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">قيد الانتظار</CardTitle>
              <CircleDashed className="h-5 w-5 text-gray-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{stats.pendingTasks}</div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Users className="h-5 w-5 text-sidebar-primary" />
              أداء الأعضاء
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {membersLoading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : memberStats?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">لا يوجد أعضاء بعد</div>
            ) : (
              memberStats?.map((stat) => (
                <div key={stat.member.id} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold text-foreground">{stat.member.name}</span>
                    <span className="text-muted-foreground font-medium">{Math.round(stat.completionRate)}% ({stat.completedTasks}/{stat.totalTasks})</span>
                  </div>
                  <Progress value={stat.completionRate} className="h-2.5 bg-secondary/30" />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <BarChart3 className="h-5 w-5 text-sidebar-primary" />
              أداء المنصات
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {platformsLoading ? (
              <div className="space-y-4">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : platformStats?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">لا توجد منصات بعد</div>
            ) : (
              platformStats?.map((stat) => (
                <div key={stat.platform.id} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <PlatformIcon name={stat.platform.name} className="h-5 w-5" />
                      <span className="font-semibold text-foreground">{stat.platform.name}</span>
                    </div>
                    <span className="text-muted-foreground font-medium">{Math.round(stat.completionRate)}% ({stat.completedTasks}/{stat.totalTasks})</span>
                  </div>
                  <Progress value={stat.completionRate} className="h-2.5 bg-secondary/30" />
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
