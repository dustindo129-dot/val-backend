# Google Cloud Text-to-Speech Setup

## Environment Variables Required

Add these environment variables to your production environment (DigitalOcean App Platform):

### Option 1: Full JSON Credentials (Recommended for DigitalOcean)

```bash
GOOGLE_CLOUD_PROJECT_ID=tts-valvrareteam
GOOGLE_APPLICATION_CREDENTIALS_JSON={"type":"service_account","project_id":"tts-valvrareteam","private_key_id":"YOUR_PRIVATE_KEY_ID","private_key":"-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----\n","client_email":"YOUR_SERVICE_ACCOUNT@tts-valvrareteam.iam.gserviceaccount.com","client_id":"YOUR_CLIENT_ID","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"YOUR_CERT_URL"}
```

**Important**: 
- Copy the entire JSON from the downloaded service account key file
- Paste it as a single line (no line breaks)
- Make sure all quotes are properly escaped

### Option 2: File Path (If you can upload files to your server)

```bash
GOOGLE_CLOUD_PROJECT_ID=tts-valvrareteam
GOOGLE_APPLICATION_CREDENTIALS=/app/server/config/google-credentials.json
```

Then upload your JSON key file to that path.

### Option 3: Separate Key Fields (Alternative)

```bash
GOOGLE_CLOUD_PROJECT_ID=tts-valvrareteam
GOOGLE_CLOUD_CLIENT_EMAIL=your-service-account@tts-valvrareteam.iam.gserviceaccount.com
GOOGLE_CLOUD_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----
```

**Important for private key**: 
- Include the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` markers
- Line breaks in the key should be represented as `\n`

## How to Get the Credentials

### Step 1: Enable Cloud Text-to-Speech API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select project: `tts-valvrareteam`
3. Go to "APIs & Services" > "Library"
4. Search for "Cloud Text-to-Speech API"
5. Click "Enable" (if not already enabled)

### Step 2: Create Service Account

1. Go to "IAM & Admin" > "Service Accounts"
2. Click "Create Service Account"
3. Name: `tts-service-account`
4. Description: `Service account for TTS API access`
5. Click "Create and Continue"

### Step 3: Grant Permissions

1. Select role: **"Cloud Text-to-Speech API User"**
2. Click "Continue"
3. Click "Done"

### Step 4: Generate Key

1. Click on the service account you just created
2. Go to "Keys" tab
3. Click "Add Key" > "Create new key"
4. Choose "JSON" format
5. Click "Create"
6. A JSON file will be downloaded - this is your credential file

### Step 5: Add to DigitalOcean

1. Go to your app in DigitalOcean App Platform
2. Navigate to "Settings" > "App-Level Environment Variables"
3. Add the environment variable(s) from Option 1, 2, or 3 above
4. Click "Save"
5. Your app will automatically redeploy

## Verification

After deploying, check your application logs. You should see:

```
🔐 Using credentials from GOOGLE_APPLICATION_CREDENTIALS_JSON
📧 Service account email: your-service-account@tts-valvrareteam.iam.gserviceaccount.com
✅ Google Cloud TTS client initialized successfully
✅ Available Vietnamese voices: X
```

If you see error messages, check that:
- The JSON is properly formatted (no extra line breaks)
- The Cloud Text-to-Speech API is enabled in your GCP project
- The service account has the correct permissions

## Pricing

- **Free tier**: 1 million characters per month
- **After free tier**: $4 USD per 1 million characters

Your app caches TTS files for 7 days, so most requests will be free (cache hits).

## Troubleshooting

### Error: "Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON"
- Make sure the JSON is on a single line with no line breaks
- Check that all quotes are present and not corrupted

### Error: "Permission denied - check if Cloud Text-to-Speech API is enabled"
- Go to Google Cloud Console and enable the API
- Make sure the service account has the correct role

### Still using mock TTS
- Check that environment variables are set correctly
- Verify the service account key is valid
- Check application logs for specific error messages
