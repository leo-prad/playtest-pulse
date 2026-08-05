// summarize.js — turn a pile of raw player feedback into ranked, quoted themes.
//
// If ANTHROPIC_API_KEY is set, we ask an LLM for structured themes. If it isn't,
// we DON'T fail — we fall back to a local keyword-frequency pass so the feature
// is always demonstrable. Graceful degradation is a deliberate design choice,
// not an accident: the product works with zero external dependencies, and gets
// smarter when a key is present.

const MODEL = "claude-sonnet-4-6";

export async function summarizeFeedback(feedbackList, customKeywords = []) {
  if (!feedbackList || feedbackList.length === 0) {
    return {
      mode: "empty",
      themes: [],
      note: "No feedback collected yet. Fire some SubmitFeedback calls from a playtest.",
    };
  }

  const cleanKeywords = (Array.isArray(customKeywords) ? customKeywords : [])
    .map((k) => String(k).replace(/[^a-zA-Z0-9\s_-]/g, "").trim().toLowerCase())
    .filter(Boolean);

  if (cleanKeywords.length > 0) {
    return customKeywordSummary(feedbackList, cleanKeywords);
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await summarizeWithLLM(feedbackList);
    } catch (err) {
      // Never let an API hiccup break the dashboard — degrade to local.
      return { ...localSummary(feedbackList), note: "LLM unavailable — showing local analysis. (" + err.message + ")" };
    }
  }
  return localSummary(feedbackList);
}

function customKeywordSummary(feedbackList, keywords) {
  const themes = [];
  for (const kw of keywords) {
    let count = 0;
    let quote = null;
    for (const raw of feedbackList) {
      if (raw.toLowerCase().includes(kw)) {
        count++;
        if (!quote) quote = raw;
      }
    }
    if (count > 0) {
      themes.push({
        title: `Mentions of "${kw}"`,
        count,
        severity: count >= feedbackList.length * 0.4 ? "high" : count >= 3 ? "medium" : "low",
        quote,
      });
    } else {
      themes.push({
        title: `Mentions of "${kw}"`,
        count: 0,
        severity: "low",
        quote: `No feedback entries contain "${kw}".`,
      });
    }
  }
  themes.sort((a, b) => b.count - a.count);

  return {
    mode: "custom",
    themes,
    note: `Filtered analysis for custom keywords: ${keywords.join(", ")}`,
  };
}

async function summarizeWithLLM(feedbackList) {
  const numbered = feedbackList
    .slice(0, 200)
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");

  const prompt =
    "You are analyzing player feedback for a video game. Below are individual " +
    "feedback entries.\n\nReturn ONLY valid JSON (no markdown, no prose) shaped as:\n" +
    '{"themes":[{"title":"short label","count":<int>,"severity":"low|medium|high","quote":"one representative verbatim quote"}]}\n\n' +
    "Rank themes by how often they recur. Give at most 6. Severity reflects how " +
    "much the theme hurts the player experience.\n\nFEEDBACK:\n" +
    numbered;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error("API " + res.status);
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  const parsed = JSON.parse(text);
  return { mode: "llm", themes: parsed.themes || [] };
}

// Local fallback: crude but honest keyword clustering. Groups feedback by shared
// meaningful words and surfaces the most common clusters with a real quote.
function localSummary(feedbackList) {
  const STOP = new Set(
    "the a an and or but is are was it this that i you we they to of in on for with my me too so very really just get got game more would make failed runs like have been from their your about when some there them than with could feel feels felt".split(
      " "
    )
  );
  const buckets = new Map();

  for (const raw of feedbackList) {
    const words = raw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w));
    const seen = new Set(words);
    for (const w of seen) {
      if (!buckets.has(w)) buckets.set(w, { count: 0, quote: raw });
      buckets.get(w).count++;
    }
  }

  const themes = [...buckets.entries()]
    .filter(([, v]) => v.count > 1)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)
    .map(([word, v]) => ({
      title: `Mentions of "${word}"`,
      count: v.count,
      severity: v.count >= feedbackList.length * 0.4 ? "high" : v.count >= 3 ? "medium" : "low",
      quote: v.quote,
    }));

  return {
    mode: "local",
    themes,
    note: "Local keyword analysis. Set ANTHROPIC_API_KEY for LLM-grade theme extraction.",
  };
}
