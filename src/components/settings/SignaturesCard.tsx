import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Trash2, Check, Edit2, PenLine, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { 
  getSignatures, 
  createSignature, 
  updateSignature, 
  deleteSignature, 
  setDefaultSignature,
  RepSignature 
} from "@/lib/repProfileQueries";
import { useProfileSync } from "@/hooks/useProfileSync";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function SignaturesCard() {
  const [signatures, setSignatures] = useState<RepSignature[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSignature, setEditingSignature] = useState<RepSignature | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { isSyncing, syncFromKB } = useProfileSync();

  // Form state
  const [name, setName] = useState("");
  const [signatureText, setSignatureText] = useState("");

  useEffect(() => {
    loadSignatures();
  }, []);

  async function loadSignatures() {
    try {
      const data = await getSignatures();
      setSignatures(data);
    } catch (err) {
      console.error("Failed to load signatures:", err);
    } finally {
      setIsLoading(false);
    }
  }

  function openCreateDialog() {
    setEditingSignature(null);
    setName("");
    setSignatureText("");
    setIsDialogOpen(true);
  }

  function openEditDialog(sig: RepSignature) {
    setEditingSignature(sig);
    setName(sig.name);
    setSignatureText(sig.signature_text);
    setIsDialogOpen(true);
  }

  async function handleSave() {
    if (!name.trim() || !signatureText.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    setIsSaving(true);
    try {
      if (editingSignature) {
        await updateSignature(editingSignature.id, {
          name: name.trim(),
          signature_text: signatureText.trim(),
        });
        toast.success("Signature updated");
      } else {
        await createSignature({
          name: name.trim(),
          signature_text: signatureText.trim(),
        });
        toast.success("Signature created");
      }
      setIsDialogOpen(false);
      loadSignatures();
    } catch (err) {
      console.error("Failed to save signature:", err);
      toast.error("Failed to save signature");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this signature?")) return;
    
    try {
      await deleteSignature(id);
      toast.success("Signature deleted");
      loadSignatures();
    } catch (err) {
      console.error("Failed to delete signature:", err);
      toast.error("Failed to delete signature");
    }
  }

  async function handleSetDefault(id: string) {
    try {
      await setDefaultSignature(id);
      toast.success("Default signature updated");
      loadSignatures();
    } catch (err) {
      console.error("Failed to set default signature:", err);
      toast.error("Failed to set default signature");
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PenLine className="h-5 w-5" />
            Email Signatures
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <PenLine className="h-5 w-5" />
                Email Signatures
              </CardTitle>
              <CardDescription>
                Create and manage email signatures for your outreach
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                disabled={isSyncing}
                onClick={async () => {
                  const result = await syncFromKB("signatures");
                  if (!result?.signatures || result.signatures.length === 0) {
                    toast.info("No signatures found in outbound emails");
                    return;
                  }
                  const highConf = result.signatures.filter(s => s.confidence >= 0.8);
                  if (highConf.length === 0) {
                    toast.info("Found signatures but confidence was too low to auto-populate.");
                    return;
                  }
                  for (const sig of highConf) {
                    try {
                      await createSignature({ name: sig.name, signature_text: sig.signature_text });
                    } catch (e) {
                      console.error("Failed to create extracted signature:", e);
                    }
                  }
                  toast.success(`Added ${highConf.length} signature(s) from emails. Review them below.`);
                  loadSignatures();
                }}
              >
                {isSyncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Sync from Emails
              </Button>
              <Button onClick={openCreateDialog} size="sm">
                <Plus className="h-4 w-4 mr-1" />
                New Signature
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {signatures.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <PenLine className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No signatures yet</p>
              <p className="text-sm">Create your first email signature</p>
            </div>
          ) : (
            <div className="space-y-3">
              {signatures.map((sig) => (
                <div
                  key={sig.id}
                  className="flex items-start justify-between p-3 border rounded-lg bg-muted/30"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{sig.name}</span>
                      {sig.is_default && (
                        <Badge variant="secondary" className="text-xs">
                          Default
                        </Badge>
                      )}
                    </div>
                    <pre className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap font-sans max-h-[100px] overflow-y-auto">
                      {sig.signature_text}
                    </pre>
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    {!sig.is_default && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSetDefault(sig.id)}
                        title="Set as default"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditDialog(sig)}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(sig.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingSignature ? "Edit Signature" : "New Signature"}
            </DialogTitle>
            <DialogDescription>
              Create a reusable email signature for your outreach
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="sigName">Signature Name</Label>
              <Input
                id="sigName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Professional, Casual, Short"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sigText">Signature Text</Label>
              <Textarea
                id="sigText"
                value={signatureText}
                onChange={(e) => setSignatureText(e.target.value)}
                placeholder={`Best regards,\n\nJohn Smith\nSenior Account Executive\nAcme Corp\n+1 (555) 123-4567`}
                className="min-h-[150px] font-mono text-sm"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {editingSignature ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
