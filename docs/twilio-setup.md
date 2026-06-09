# Twilio Setup

This project can run with the mock SMS gateway or with real Twilio outbound SMS.

Local Twilio testing requires a public URL because Twilio cannot call `localhost` directly. The easiest local setup is to expose the web app through ngrok and configure the Twilio phone number's inbound SMS webhook to point to that ngrok URL.

## 1. Start the application

```bash
docker compose up --build
```

The web app must be reachable on port `3000`, and the worker must be running.

## 2. Configure local secrets

Create a local `.env` file. Do not commit it.

```bash
SMS_GATEWAY=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
```

`TWILIO_AUTH_TOKEN` is required for inbound webhook signature validation. Signature validation is enabled by default when `SMS_GATEWAY=twilio`.

API key auth is also supported:

```bash
SMS_GATEWAY=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_API_KEY_SID=SK...
TWILIO_API_KEY_SECRET=...
```

If you use API key auth for outbound SMS, still provide `TWILIO_AUTH_TOKEN` when accepting real inbound Twilio webhooks so the app can validate `X-Twilio-Signature`.

## 3. Expose localhost with ngrok

```bash
ngrok http 3000
```

Copy the HTTPS forwarding URL, for example:

```text
https://example.ngrok-free.app
```

The webhook path for this app is:

```text
https://example.ngrok-free.app/api/webhooks/twilio
```

## 4. Find the Twilio phone number SID

Twilio's API uses the `PN...` SID for a phone number, not the E.164 phone number itself.

```bash
set -a; source .env; set +a

curl -s -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers.json?PhoneNumber=%2B15013659142"
```

Look for:

```json
{
  "sid": "PN..."
}
```

## 5. Configure the inbound SMS webhook

Replace `PN...` and the ngrok hostname with your actual values.

```bash
set -a; source .env; set +a

curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/PN....json" \
  --data-urlencode "SmsUrl=https://example.ngrok-free.app/api/webhooks/twilio" \
  --data-urlencode "SmsMethod=POST" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN"
```

The response should include:

```json
{
  "sms_method": "POST",
  "sms_url": "https://example.ngrok-free.app/api/webhooks/twilio"
}
```

## 6. Test the webhook without sending SMS

Real Twilio requests include `X-Twilio-Signature`, but a basic local `curl` does not. For an unsigned local smoke test only, temporarily set this in `.env` and restart the web service:

```bash
TWILIO_VALIDATE_SIGNATURE=false
```

```bash
curl -i -X POST "https://example.ngrok-free.app/api/webhooks/twilio" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "MessageSid=SMNGROKTEST001" \
  --data-urlencode "From=+5511975185804" \
  --data-urlencode "To=+15013659142" \
  --data-urlencode "Body=ngrok webhook test"
```

Expected response:

```text
202 Accepted
```

Turn signature validation back on before testing real SMS:

```bash
TWILIO_VALIDATE_SIGNATURE=true
```

## 7. Test real SMS

Send an SMS from your phone to the Twilio number.

Watch logs:

```bash
docker compose logs -f web worker
```

Expected log sequence:

```text
ingest inbound sms
webhook accepted
claimed job
sent outbound sms
```

After the worker delay, your phone should receive the generated response.

## Common issues

- If no `ingest inbound sms` log appears, Twilio is not reaching the app. Check the `SmsUrl`, ngrok process, and HTTP method.
- If Twilio returns `SmsUrl is not valid`, make sure the URL has no line breaks or placeholder text.
- If the app returns `403`, check that Twilio is calling the exact ngrok URL configured in `SmsUrl` and that `TWILIO_AUTH_TOKEN` matches the account.
- If the app records the inbound message but the phone receives no reply, check worker logs and message status in the admin UI.
- If using trial Twilio accounts, the recipient phone number may need to be verified in Twilio before outbound SMS can be delivered.
