# try-hum-x402

Call **Hum** — a phone-shaped LLM marketplace — via the real HTTP 402 + EIP-3009 dance. No account, no API key, no provider relationship. Just a wallet (auto-generated if you don't bring one).

## Use it

```bash
npx github:haxaco/try-hum-x402 "your prompt here"
```

That's the whole demo. The script:

1. POSTs to Hum's endpoint with no payment → receives **HTTP 402** with a price quote
2. Signs an **EIP-3009 USDC `transferWithAuthorization`** locally with `viem`
3. Retries with `X-PAYMENT` → Hum settles via Sly's facilitator, runs **OpenRouter**, returns the model output + receipt

```bash
# pick a model
npx github:haxaco/try-hum-x402 "translate: the coffee is ready" --model gemini
npx github:haxaco/try-hum-x402 "review this PR..." --model claude --max 400

# show available models
npx github:haxaco/try-hum-x402 --help
```

Models: `claude` · `gpt` · `gemini` · `llama` · `mistral` (aliases for the corresponding OpenRouter slugs).

## What the receipt shows

- The model that actually served (OpenRouter may return a specific variant)
- Real `prompt_tokens → completion_tokens` from the API response
- Real OpenRouter cost vs. what you paid (Hum's margin %)
- Settlement tx hash (mock on Base Sepolia in dev mode)
- EIP-3009 signature prefix

## Persistent wallet

By default a random secp256k1 key is generated for each run. To use your own:

```bash
PRIVATE_KEY=0xabc... npx github:haxaco/try-hum-x402 "your prompt"
```

## Endpoint URL

The default `HUM_URL` is a Cloudflare quick-tunnel that rotates when the host restarts. If you get a 404/520, ping @haxaco for the current URL or set `HUM_URL=https://...trycloudflare.com` yourself.

## What's actually happening

```
 buyer (your wallet)                    Hum (phone)              Sly facilitator
       │                                    │                          │
       │ POST /api/x402-inference (no pay)  │                          │
       │ ──────────────────────────────▶    │                          │
       │ ◀──── HTTP 402 + price quote ────  │                          │
       │                                    │                          │
   [sign EIP-3009 locally with viem]        │                          │
       │                                    │                          │
       │ POST /api/x402-inference + X-PAY   │                          │
       │ ──────────────────────────────▶    │ POST /facilitator/settle │
       │                                    │ ─────────────────────────▶
       │                                    │ ◀── settled, txHash ──── │
       │                                    │                          │
       │                          [OpenRouter call]                    │
       │                                    │                          │
       │ ◀──── 200 + receipt + output ───── │                          │
```

x402 spec: https://www.x402.org

## License

MIT
