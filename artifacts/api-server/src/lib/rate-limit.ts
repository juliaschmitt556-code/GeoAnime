import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { NextFunction, Request, Response } from "express";

let limiter: Ratelimit | null | undefined;

function getLimiter(): Ratelimit | null {
  if (limiter !== undefined) return limiter;

  const url = process.env["UPSTASH_REDIS_REST_URL"];
  const token = process.env["UPSTASH_REDIS_REST_TOKEN"];
  if (!url || !token) {
    limiter = null;
    return limiter;
  }

  limiter = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(60, "1 m"),
    prefix: "geoanime:api",
    analytics: true,
  });
  return limiter;
}

function clientKey(req: Request): string {
  const forwarded = req.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.ip || "anonymous";
}

export async function rateLimitApiRequest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const requestLimiter = getLimiter();
  if (!requestLimiter) {
    next();
    return;
  }

  try {
    const result = await requestLimiter.limit(`${clientKey(req)}:${req.path}`);
    res.setHeader("RateLimit-Limit", String(result.limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, result.remaining)));
    res.setHeader("RateLimit-Reset", String(result.reset));

    if (!result.success) {
      res.status(429).json({
        error: "Too many requests. Please try again shortly.",
        retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
      });
      return;
    }
  } catch (error) {
    req.log.warn({ err: error }, "Upstash rate limiter unavailable");
  }

  next();
}
