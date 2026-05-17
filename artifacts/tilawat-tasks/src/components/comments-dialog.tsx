import { useState } from "react";
import {
  useListComments,
  useCreateComment,
  useDeleteComment,
  getListCommentsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, MessageSquare, Trash2, Send } from "lucide-react";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import { useCanEdit } from "@/lib/roles";

interface CommentsDialogProps {
  taskId: number | null;
  taskTitle?: string;
  onClose: () => void;
}

export function CommentsDialog({ taskId, taskTitle, onClose }: CommentsDialogProps) {
  const [commentText, setCommentText] = useState("");
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canEdit = useCanEdit();

  const { data: comments, isLoading } = useListComments(taskId ?? 0, {
    query: {
      enabled: taskId != null,
      queryKey: getListCommentsQueryKey(taskId ?? 0),
    },
  });

  const createComment = useCreateComment();
  const deleteComment = useDeleteComment();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim() || !taskId) return;
    createComment.mutate(
      {
        id: taskId,
        data: {
          content: commentText.trim(),
          authorName: user?.displayName ?? user?.username ?? "مستخدم",
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListCommentsQueryKey(taskId),
          });
          setCommentText("");
        },
      }
    );
  };

  const handleDelete = (commentId: number) => {
    if (!taskId) return;
    deleteComment.mutate(
      { taskId, id: commentId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListCommentsQueryKey(taskId),
          });
        },
      }
    );
  };

  return (
    <Dialog
      open={taskId != null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setCommentText("");
        }
      }}
    >
      <DialogContent
        className="sm:max-w-[520px] max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden"
        dir="rtl"
      >
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/50">
          <DialogTitle className="text-xl font-bold flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-sidebar-primary" />
            التعليقات
          </DialogTitle>
          {taskTitle && (
            <p className="text-sm text-muted-foreground truncate mt-0.5">
              {taskTitle}
            </p>
          )}
        </DialogHeader>

        <ScrollArea className="flex-1 max-h-[45vh] px-6">
          {isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !comments || comments.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <MessageSquare className="h-10 w-10 mx-auto mb-3 opacity-25" />
              <p className="text-sm font-medium">لا تعليقات بعد</p>
              <p className="text-xs mt-1 opacity-70">
                كن أول من يضيف ملاحظة على هذه المهمة
              </p>
            </div>
          ) : (
            <div className="space-y-3 py-4">
              {comments.map((c) => (
                <div key={c.id} className="flex items-start gap-2.5 group">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-sidebar-primary/15 flex items-center justify-center">
                    <span className="text-xs font-bold text-sidebar-primary">
                      {c.authorName.charAt(0)}
                    </span>
                  </div>
                  <div className="flex-1 bg-muted/40 rounded-2xl rounded-tr-sm px-3.5 py-2.5 border border-border/40">
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="text-sm font-semibold text-foreground leading-none">
                        {c.authorName}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {format(new Date(c.createdAt), "d MMM، h:mm a", {
                          locale: ar,
                        })}
                      </span>
                    </div>
                    <p className="text-sm text-foreground/85 whitespace-pre-wrap leading-relaxed">
                      {c.content}
                    </p>
                  </div>
                  {canEdit && (
                    <button
                      onClick={() => handleDelete(c.id)}
                      title="حذف التعليق"
                      className="opacity-0 group-hover:opacity-100 transition-opacity mt-2 p-1 text-muted-foreground hover:text-red-500 rounded"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        <form
          onSubmit={handleSubmit}
          className="px-6 pt-4 pb-6 border-t border-border/50 space-y-3 mt-auto"
        >
          <Textarea
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            placeholder="اكتب تعليقاً أو ملاحظة..."
            className="min-h-[80px] resize-none text-sm"
            dir="rtl"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSubmit(e as unknown as React.FormEvent);
              }
            }}
          />
          <Button
            type="submit"
            className="w-full bg-sidebar-primary hover:bg-sidebar-primary/90 text-sidebar-primary-foreground font-semibold"
            disabled={!commentText.trim() || createComment.isPending}
          >
            {createComment.isPending ? (
              <Loader2 className="ml-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="ml-2 h-4 w-4" />
            )}
            إرسال التعليق
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
