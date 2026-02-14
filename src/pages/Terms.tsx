import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

export default function Terms() {
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

        <h1 className="text-3xl font-bold text-foreground mb-1">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-8">Effective Date: February 14, 2026</p>

        <div className="space-y-8 text-foreground leading-relaxed">
          <p className="text-muted-foreground">
            By accessing or using DrivePilot, you agree to these Terms.
          </p>

          <section className="space-y-2">
            <h2 className="text-xl font-semibold">1. Description of Service</h2>
            <p className="text-muted-foreground">
              DrivePilot is a SaaS platform providing email automation, workflow management, and AI-powered productivity tools.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-xl font-semibold">2. Account Responsibility</h2>
            <p className="text-muted-foreground">You are responsible for:</p>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>Maintaining account confidentiality</li>
              <li>All activity under your account</li>
              <li>Ensuring compliance with Gmail and anti-spam laws</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-xl font-semibold">3. Acceptable Use</h2>
            <p className="text-muted-foreground">You agree NOT to:</p>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>Send spam or unlawful communications</li>
              <li>Use the Service for illegal activity</li>
              <li>Violate Google API policies</li>
              <li>Attempt unauthorized access</li>
            </ul>
            <p className="text-sm text-muted-foreground">We may suspend accounts for violations.</p>
          </section>

          <section className="space-y-2">
            <h2 className="text-xl font-semibold">4. Gmail Integration</h2>
            <p className="text-muted-foreground">If you connect Gmail:</p>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>You authorize DrivePilot to access Gmail per granted scopes</li>
              <li>You may revoke access anytime</li>
              <li>We only access data required for functionality</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-xl font-semibold">5. Subscription & Payments</h2>
            <p className="text-muted-foreground">If applicable:</p>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>Some features require paid subscription</li>
              <li>Fees are billed in advance</li>
              <li>No guarantees of uninterrupted service</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-xl font-semibold">6. Intellectual Property</h2>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>All DrivePilot software, branding, and technology remain our property</li>
              <li>Users retain ownership of their email content</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-xl font-semibold">7. Limitation of Liability</h2>
            <p className="text-muted-foreground">DrivePilot is provided "as is". We are not liable for:</p>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>Email delivery failures</li>
              <li>Third-party service outages</li>
              <li>Data loss beyond our reasonable control</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-xl font-semibold">8. Termination</h2>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground">
              <li>We may terminate accounts for violations</li>
              <li>Users may delete their account at any time</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-xl font-semibold">9. Governing Law</h2>
            <p className="text-muted-foreground">These Terms are governed by the laws of Israel.</p>
          </section>

          <section className="space-y-2">
            <h2 className="text-xl font-semibold">10. Contact</h2>
            <p className="text-muted-foreground">
              DrivePilot
              <br />
              Email:{" "}
              <a href="mailto:support@drivepilot.app" className="underline hover:text-foreground">
                support@drivepilot.app
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
