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
  /** True when isLoading has been stuck past AUTH_STALL_MS — the auth client can
   *  hang forever (cross-tab lock, pending refresh); routes show a way out instead
   *  of a bare spinner (BUG-014). */
  authStalled: boolean;
}

// How long the initial session/profile load may spin before we offer Reload / Sign in.
const AUTH_STALL_MS = 10_000;

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<{ onboarding_done: boolean; role: string } | null>(null);
  const [authStalled, setAuthStalled] = useState(false);

  // Stall detector: arm while loading, disarm as soon as loading resolves.
  useEffect(() => {
    if (!isLoading) { setAuthStalled(false); return; }
    const t = setTimeout(() => setAuthStalled(true), AUTH_STALL_MS);
    return () => clearTimeout(t);
  }, [isLoading]);

  useEffect(() => {
    let isMounted = true;

    // User whose profile is loaded (or loading). supabase-js re-emits SIGNED_IN
    // every time the tab becomes visible again (_recoverAndRefresh) — treating
    // that as a new sign-in flipped isLoading, which unmounted the whole app to a
    // spinner, refetched everything, and after 10s showed AuthStalledCard.
    let loadedUserId: string | null = null;

    const loadProfileForUser = async () => {
      try {
        // Read first; only create when missing (saves a getUser + select per load).
        const prof = await getCurrentProfile().catch(async (err) => {
          if ((err as { code?: string })?.code !== "PGRST116") throw err; // PGRST116 = no row
          await createProfileIfMissing();
          return getCurrentProfile();
        });
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
        loadedUserId = null;
        setProfile(null);
        setIsLoading(false);
      } else if (event === "SIGNED_IN" && session.user.id !== loadedUserId) {
        loadedUserId = session.user.id;
        // New sign-in: set loading and fetch profile via setTimeout to avoid
        // Supabase client deadlock (auth state change callback must return first)
        setIsLoading(true);
        setTimeout(() => {
          if (isMounted) loadProfileForUser();
        }, 0);
      }
      // TOKEN_REFRESHED: silently update session/user (done above). Do NOT
      // toggle isLoading or refetch profile — that unmounts the whole route
      // tree mid-session and wipes in-progress form state (e.g. NewCampaign).
    });

    // INITIAL load — controls isLoading for the first render
    const initializeAuth = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!isMounted) return;
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          if (session.user.id === loadedUserId) return; // SIGNED_IN already loading it
          loadedUserId = session.user.id;
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
    <AuthContext.Provider value={{ user, session, isLoading, signUp, signIn, signOut, profile, refreshProfile, authStalled }}>
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
