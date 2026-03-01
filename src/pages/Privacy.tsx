import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-8"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </Link>

        <h1 className="text-3xl font-bold text-foreground mb-1">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-8">
          Effective Date: February 14, 2026 · Last Updated: February 14, 2026
        </p>

        <div className="space-y-8 text-foreground leading-relaxed">
          <p>
            DrivePilot ("Company", "we", "our", "us") operates the DrivePilot application (the "Service").
            This Privacy Policy explains how we collect, use, and protect your information when you use our Service.
          </p>

          {/* 1 */}
          <section className="space-y-4">
            <h2 className="text-xl font-semibold">1. Information We Collect</h2>

            <div className="space-y-2">
              <h3 className="text-base font-medium">1.1 Account Information</h3>
              <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
                <li>Name</li>
                <li>Email address</li>
                <li>Google account information (if signing in via Google)</li>
              </ul>
            </div>

            <div className="space-y-2">
              <h3 className="text-base font-medium">1.2 Gmail Data (If You Connect Gmail)</h3>
              <p className="text-muted-foreground">
                If you authorize DrivePilot to access your Gmail account, we may access:
              </p>
              <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
                <li>Email metadata (sender, subject, timestamp)</li>
                <li>Email content (only as required to provide automation features)</li>
                <li>Email thread IDs</li>
                <li>Labels</li>
              </ul>

              <div className="rounded-md border border-border bg-muted/50 p-4 space-y-1 text-sm">
                <p className="font-medium text-foreground">We do NOT:</p>
                <ul className="list-disc pl-5 text-muted-foreground space-y-0.5">
                  <li>Sell Gmail data</li>
                  <li>Use Gmail data for advertising</li>
                  <li>Use Gmail data for AI training</li>
                </ul>
              </div>

              <p className="text-muted-foreground">Gmail data is used strictly to:</p>
              <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
                <li>Send emails on your behalf</li>
                <li>Generate draft responses</li>
                <li>Automate sequences</li>
                <li>Provide workflow insights</li>
              </ul>
              <p className="text-sm text-muted-foreground">
                DrivePilot complies with the{" "}
                <a
                  href="https://developers.google.com/terms/api-services-user-data-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  Google API Services User Data Policy
                </a>.
              </p>
            </div>
          </section>

          {/* 2 */}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">2. How We Use Information</h2>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>Provide and maintain the Service</li>
              <li>Authenticate users</li>
              <li>Enable email automation features</li>
              <li>Improve system performance</li>
              <li>Provide support</li>
            </ul>
          </section>

          {/* 3 */}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">3. Data Storage</h2>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>Data is stored securely using encrypted infrastructure</li>
              <li>Communication is encrypted via HTTPS</li>
              <li>Access tokens are encrypted</li>
              <li>We retain data only as long as necessary to provide services</li>
            </ul>
          </section>

          {/* 4 */}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">4. Data Sharing</h2>
            <p className="text-muted-foreground">We do NOT sell personal data. We may share data only with:</p>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>Infrastructure providers</li>
              <li>Legal authorities if required by law</li>
            </ul>
          </section>

          {/* 5 */}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">5. Data Retention</h2>
            <p className="text-muted-foreground">We retain user data until:</p>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>The account is deleted</li>
              <li>The user revokes Gmail permissions</li>
              <li>Required retention period ends</li>
            </ul>
            <p className="text-muted-foreground">
              Users may request deletion at:{" "}
              <a href="mailto:support@drivepilot.app" className="underline hover:text-foreground">
                support@drivepilot.app
              </a>
            </p>
          </section>

          {/* 6 */}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">6. Your Rights</h2>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>Access your data</li>
              <li>Request correction</li>
              <li>Request deletion</li>
              <li>Revoke Google access at any time via Google Security settings</li>
            </ul>
          </section>

          {/* 7 */}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">7. Security</h2>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>Encrypted data transmission (TLS)</li>
              <li>Secure storage</li>
              <li>Access control</li>
              <li>Token encryption</li>
            </ul>
            <p className="text-sm text-muted-foreground">However, no system is 100% secure.</p>
          </section>

          {/* 8 */}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">8. Third-Party Services</h2>
            <p className="text-muted-foreground">DrivePilot integrates with:</p>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>Google APIs (Gmail)</li>
              <li>Cloud backend services</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              We comply with Google's Limited Use requirements.
            </p>
          </section>

          {/* 9 */}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">9. Children's Privacy</h2>
            <p className="text-muted-foreground">The Service is not intended for users under 18.</p>
          </section>

          {/* 10 */}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">10. Changes</h2>
            <p className="text-muted-foreground">
              We may update this Privacy Policy. Continued use of the Service means acceptance.
            </p>
          </section>

          {/* 11 */}
          <section className="space-y-2">
            <h2 className="text-xl font-semibold">11. Contact</h2>
            <p className="text-muted-foreground">
              DrivePilot · Shai Benchmuel
              <br />
              Email:{" "}
              <a href="mailto:support@drivepilot.app" className="underline hover:text-foreground">
                support@drivepilot.app
              </a>
              <br />
              Location: Israel
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
