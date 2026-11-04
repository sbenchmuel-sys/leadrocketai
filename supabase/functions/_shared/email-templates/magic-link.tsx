/// <reference types="npm:@types/react@18.3.1" />

import * as React from 'npm:react@18.3.1'

import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Text,
} from 'npm:@react-email/components@0.0.22'

interface MagicLinkEmailProps {
  siteName: string
  confirmationUrl: string
  token: string
}

export const MagicLinkEmail = ({
  siteName,
  confirmationUrl,
  token,
}: MagicLinkEmailProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your sign-in code for {siteName}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Your sign-in code</Heading>
        <Text style={code}>{token}</Text>
        <Text style={text}>
          Enter this code on the DrivePilot sign-in page. It expires shortly.
        </Text>
        <Link style={link} href={confirmationUrl}>
          Or click here to sign in
        </Link>
        <Text style={footer}>
          If you didn't request this link, you can safely ignore this email.
        </Text>
      </Container>
    </Body>
  </Html>
)

export default MagicLinkEmail

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif' }
const container = { padding: '20px 25px' }
const h1 = {
  fontSize: '22px',
  fontWeight: 'bold' as const,
  color: '#000000',
  margin: '0 0 20px',
}
const text = {
  fontSize: '14px',
  color: '#55575d',
  lineHeight: '1.5',
  margin: '0 0 25px',
}
const code = {
  fontFamily: 'Courier New, Courier, monospace',
  fontSize: '36px',
  fontWeight: 'bold' as const,
  letterSpacing: '8px',
  color: '#000000',
  margin: '0 0 25px',
}
const link = {
  color: '#55575d',
  fontSize: '12px',
  textDecoration: 'underline',
}
const footer = { fontSize: '12px', color: '#999999', margin: '30px 0 0' }
