import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { createProfileIfMissing, getCurrentProfile } from "@/lib/supabaseQueries";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  signUp: (email: string, password: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  profile: { onboarding_done: boolean; role: string } | null;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<{ onboarding_done: boolean; role: string } | null>(null);

  useEffect(() => {
    let isMounted = true;

    const loadProfileForUser = async () => {
      try {
        await createProfileIfMissing();
        const prof = await getCurrentProfile();
        if (isMounted) setProfile({ onboarding_done: prof.onboarding_done, role: prof.role });
      } catch (err) {
        console.error("[AuthContext] Failed to load profile:", err);
        if (isMounted) setProfile(null);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    // Listener for ONGOING auth changes (sign-in, sign-out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!isMounted) return;
      setSession(session);
      setUser(session?.user ?? null);

      if (!session?.user) {
        setProfile(null);
        setIsLoading(false);
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        // New sign-in: set loading and fetch profile via setTimeout to avoid
        // Supabase client deadlock (auth state change callback must return first)
        setIsLoading(true);
        setTimeout(() => {
          if (isMounted) loadProfileForUser();
        }, 0);
      }
    });

    // INITIAL load — controls isLoading for the first render
    const initializeAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!isMounted) return;
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          await loadProfileForUser();
        } else {
          setProfile(null);
          setIsLoading(false);
        }
      } catch {
        if (isMounted) setIsLoading(false);
      }
    };

    initializeAuth();

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);




  const signUp = async (email: string, password: string) => {
    const redirectUrl = `${window.location.origin}/`;
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: redirectUrl },
    });
    return { error: error as Error | null };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error as Error | null };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setProfile(null);
  };

  const refreshProfile = async () => {
    try {
      const prof = await getCurrentProfile();
      setProfile({ onboarding_done: prof.onboarding_done, role: prof.role });
    } catch (err) {
      console.error("Failed to refresh profile:", err);
    }
  };

  return (
    <AuthContext.Provider value={{ user, session, isLoading, signUp, signIn, signOut, profile, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
