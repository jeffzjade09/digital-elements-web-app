// Authentication (Google SSO) + session handling + role-based access control.
//
// Identity is proven by Google; authorization comes from the app_users table.
// Only emails present in app_users may sign in — anyone else is denied.

import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { getPool, getUserByEmail, getUserById, touchLogin } from "./db.js";

// Permission model. Keep this as the single source of truth.
const PERMISSIONS = {
  admin:     { manageWebsites: true,  deleteWebsite: true,  manageUsers: true,  editSocial: true,  manageSettings: true },
  webdev:    { manageWebsites: true,  deleteWebsite: false, manageUsers: false, editSocial: true,  manageSettings: false },
  social:    { manageWebsites: false, deleteWebsite: false, manageUsers: false, editSocial: true,  manageSettings: false },
  seo:       { manageWebsites: false, deleteWebsite: false, manageUsers: false, editSocial: false, manageSettings: false },
  publisher: { manageWebsites: false, deleteWebsite: false, manageUsers: false, editSocial: false, manageSettings: false },
};

export function permsFor(role) {
  return PERMISSIONS[role] || PERMISSIONS.seo;
}

export function configureAuth(app, settings) {
  const isProd = settings.publicUrl.startsWith("https://");
  app.set("trust proxy", 1); // needed for secure cookies behind a proxy (Railway/Render/Nginx)

  const PgStore = connectPgSimple(session);
  app.use(session({
    store: new PgStore({ pool: getPool(), createTableIfMissing: true }),
    secret: settings.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,          // HTTPS-only cookie in production
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  }));

  passport.use(new GoogleStrategy(
    {
      clientID: settings.google.clientId,
      clientSecret: settings.google.clientSecret,
      callbackURL: `${settings.publicUrl}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value?.toLowerCase();
        if (!email) return done(null, false, { message: "no-email" });
        const user = await getUserByEmail(email);
        if (!user) return done(null, false, { message: "not-allowed" }); // not on the allow-list
        await touchLogin(user.id, profile.displayName);
        return done(null, { id: user.id, email: user.email, name: profile.displayName || user.name, role: user.role, theme: user.theme || "dark" });
      } catch (err) {
        return done(err);
      }
    }
  ));

  // Store only the id in the session; reload the user (and current role) each request.
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const u = await getUserById(id);
      if (!u) return done(null, false); // user was removed -> treated as logged out
      done(null, { id: u.id, email: u.email, name: u.name, role: u.role, theme: u.theme || "dark" });
    } catch (err) {
      done(err);
    }
  });

  app.use(passport.initialize());
  app.use(passport.session());

  // ---- Auth routes ----
  app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));

  app.get("/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/login?error=denied" }),
    (req, res) => res.redirect("/")
  );

  app.post("/auth/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => res.json({ ok: true }));
    });
  });
}

// ---- Middleware ----
export function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "Not signed in" });
  return res.redirect("/login");
}

export function requirePerm(perm) {
  return (req, res, next) => {
    if (!(req.isAuthenticated && req.isAuthenticated())) {
      return res.status(401).json({ ok: false, error: "Not signed in" });
    }
    if (permsFor(req.user.role)[perm]) return next();
    return res.status(403).json({ ok: false, error: "You don't have permission for this action" });
  };
}

// Reject cross-site state-changing requests (defence-in-depth alongside sameSite cookies).
export function sameOriginOnly(req, res, next) {
  if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    const origin = req.get("origin");
    const host = req.get("host");
    if (origin && new URL(origin).host !== host) {
      return res.status(403).json({ ok: false, error: "Cross-origin request blocked" });
    }
  }
  next();
}
