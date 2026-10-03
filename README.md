# Dokploy MCP (OAuth, GitHub login)

claude.ai custom connector-এর জন্য Dokploy MCP সার্ভার। OAuth 2.1 (DCR + PKCE) নিজেই চালায়, লগইন হয় GitHub দিয়ে, শুধু আপনার অ্যাকাউন্ট ঢুকতে পারে।

## ১. GitHub OAuth App
GitHub → Settings → Developer settings → OAuth Apps → New
- Homepage URL: `https://mcp.raynx.ie`
- Authorization callback URL: `https://mcp.raynx.ie/github/callback`
- Client ID আর Client secret সংরক্ষণ করুন।
- আপনার numeric ID: `curl https://api.github.com/users/mdnhs` → `"id"`।

## ২. Dokploy API key
Dokploy → Settings → Profile → API/CLI → Generate API key।

## ৩. Deploy (Dokploy)
1. পুরনো `mcp.raynx.ie` অ্যাপ/ডোমেইন থাকলে আগে মুছুন।
2. Project → Create Service → Application → Provider **Drop** → এই zip আপলোড → Build type **Dockerfile**।
3. Environment-এ `.env.example`-এর ভেরিয়েবলগুলো দিন। `AUTH_SECRET` = `openssl rand -hex 32`।
4. Domains: Host `mcp.raynx.ie`, Container port `3000`, HTTPS + Let's Encrypt। (Cloudflare-এ wildcard আছে।)
5. Deploy। চেক: `https://mcp.raynx.ie/health` → `{"ok":true}`।

## ৪. claude.ai-তে যোগ
Settings → Connectors → Add custom connector → URL `https://mcp.raynx.ie/mcp`।
Advanced-এ **Register automatically (DCR)** বেছে নিন → GitHub-এ লগইন → Allow।

## টুল
`dokploy_overview`, `dokploy_get`, `dokploy_deploy`, `dokploy_search_api` (৬০০+ অপারেশন), `dokploy_call_api` (যেকোনো অপারেশন)।

## নিরাপত্তা
- delete/stop/update জাতীয় অপারেশনে `confirm:true` লাগে (Claude ইউজারকে জিজ্ঞেস করবে)।
- env/password/token জাতীয় ফিল্ড `[redacted]` হয়ে ফেরে (`REVEAL_SECRETS=true` দিলে খোলা)।
- শুধু দেখার জন্য `READ_ONLY=true`।
- স্টেটলেস: কোনো ডেটাবেস নেই। `AUTH_SECRET` বদলালে সব সেশন বাতিল হয়, আবার কানেক্ট করতে হবে।
- প্রতিটি টুল কল লগে লেখা হয় (Dokploy → Logs)।
- সতর্কতা: পূর্ণ নিয়ন্ত্রণ মানে প্রম্পট-ইনজেকশন ঝুঁকি; অচেনা কনটেন্ট পড়ার সময় সাবধান।

## টেস্ট
`npm test` (নকল GitHub/Dokploy দিয়ে পুরো ফ্লো)।
