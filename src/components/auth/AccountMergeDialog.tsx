import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { lovable } from "@/integrations/lovable/index";
import { toast } from "sonner";

interface AccountMergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mergeEmail: string;
}

export default function AccountMergeDialog({ open, onOpenChange, mergeEmail }: AccountMergeDialogProps) {
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { signIn } = useAuth();

  const handleMerge = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      // Step 1: Sign in with existing password
      const { error: signInError } = await signIn(mergeEmail, password);
      if (signInError) {
        toast.error("Incorrect password. Please try again.");
        setIsSubmitting(false);
        return;
      }

      // Step 2: Link Google identity to the now-authenticated account
      const { error: linkError } = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });

      if (linkError) {
        toast.error("Failed to link Google account. Please try again.");
        setIsSubmitting(false);
        return;
      }

      // OAuth will redirect, so we won't reach here normally
      toast.success("Accounts linked! Redirecting...");
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || "Something went wrong");
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Account already exists</DialogTitle>
          <DialogDescription>
            An account with <strong>{mergeEmail}</strong> already exists. Sign in with your password to link your Google account.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleMerge} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="merge-password">Password</Label>
            <Input
              id="merge-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your existing password"
              required
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Linking accounts..." : "Sign in & Link Google"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
