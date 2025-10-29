import { GoogleGenAI, Type } from "@google/genai";
import type { Lead } from '../types';

const TITLE_KEYWORDS = [
  "uniform",
  "uniform fabric",
  "uniform blazers",
  "uniform jackets",
  "nurse uniform",
  "chef coats",
  "corporate uniform",
  "staff uniform",
  "ncc uniform",
  "waiter uniform",
];

const EXCLUDED_LOCATIONS = [
  "delhi",
  "mumbai",
  "gurgaon",
  "ahmedabad",
  "surat",
  "thane",
  "uae",
  "usa",
  "uk",
  "dubai",
  "singapore",
  "abroad",
  "international",
  "outside india",
  "foreign",
];

const PREFERRED_LOCATIONS = [
  "noida",
  "jaipur",
  "lucknow",
  "kanpur",
  "ghaziabad",
  "varanasi",
  "meerut",
  "agra",
  "patna",
  "chandigarh",
  "dehradun",
  "raipur",
  "bhopal",
  "jammu",
  "amritsar",
  "ludhiana",
  "faridabad",
  "gaziabad",
];

const CATEGORY_ALLOW_LIST = [
  "kids school uniform",
  "school uniforms",
  "school blazers",
  "school uniform fabric",
  "worker uniform",
  "uniform fabric",
  "security guard uniform",
  "petrol pump uniform",
  "safety suits",
  "boys school uniform",
  "surgical gown",
  "hospital uniforms",
  "corporate uniform",
];

const CONTACT_DELAY_PATTERN = [5, 1, 10];

function normalizeDelay(minutes?: number): number {
  if (!minutes || minutes < 1) return CONTACT_DELAY_PATTERN[0];
  const rounded = Math.round(minutes);
  if (CONTACT_DELAY_PATTERN.includes(rounded)) {
    return rounded;
  }
  const closest = CONTACT_DELAY_PATTERN.reduce((prev, curr) => Math.abs(curr - rounded) < Math.abs(prev - rounded) ? curr : prev, CONTACT_DELAY_PATTERN[0]);
  return closest;
}

function containsKeyword(value: string, keywords: string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some(keyword => lower.includes(keyword));
}

function isExcludedLocation(location: string): boolean {
  const lower = location.toLowerCase();
  return EXCLUDED_LOCATIONS.some(city => lower.includes(city));
}

function isPreferredLocation(location: string): boolean {
  const lower = location.toLowerCase();
  return PREFERRED_LOCATIONS.some(city => lower.includes(city));
}

function evaluateLeadHeuristically(lead: Lead, delayCursor: number): { isQualified: boolean; reason: string; delay: number } {
  const reasons: string[] = [];
  let qualified = true;

  const title = `${lead.enquiryTitle || ''} ${lead.requirement || ''}`.trim();
  if (!title || !containsKeyword(title, TITLE_KEYWORDS)) {
    qualified = false;
    reasons.push('Missing required keyword in enquiry title.');
  }

  if (!lead.location || isExcludedLocation(lead.location)) {
    qualified = false;
    reasons.push('Lead location is excluded.');
  } else if (!isPreferredLocation(lead.location)) {
    qualified = false;
    reasons.push('Lead location is outside preferred northern cities.');
  }

  if (!lead.quantity || lead.quantity <= 100) {
    qualified = false;
    reasons.push('Quantity <= 100 units.');
  }

  if (!lead.category || !CATEGORY_ALLOW_LIST.includes(lead.category.toLowerCase())) {
    qualified = false;
    reasons.push('Category is not an approved match.');
  }

  const orderValue = lead.probableOrderValueMin ?? lead.probableOrderValueMax ?? 0;
  if (!orderValue || orderValue <= 50000) {
    qualified = false;
    reasons.push('Probable order value <= 50,000 INR.');
  }

  const delay = CONTACT_DELAY_PATTERN[delayCursor % CONTACT_DELAY_PATTERN.length];
  return {
    isQualified: qualified,
    reason: qualified ? 'Lead meets all heuristic requirements.' : reasons.join(' '),
    delay,
  };
}

// Fix: Use Vite env var and validate presence.
const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
if (!apiKey) {
  throw new Error("Missing VITE_GEMINI_API_KEY. Set it in your .env.local file.");
}
const ai = new GoogleGenAI({ apiKey });

export async function analyzeLeadsWithGemini(leads: Lead[]): Promise<Lead[]> {
  console.log('[Gemini Service] Starting lead analysis...');
  console.log(`[Gemini Service] Number of leads to analyze: ${leads.length}`);
  
  if (leads.length === 0) {
    console.log('[Gemini Service] No leads to analyze, returning empty array');
    return leads;
  }

  const prompt = `
    You are an expert sales analyst specializing in B2B leads from IndiaMART.
    Analyze the following list of leads. For each lead, provide a "potentialScore" from 1 to 100 (100 being the highest potential) and a brief "analysis" (max 20 words) explaining the score.
    
    A higher score should be given to leads with:
    - Clear and specific product requirements.
    - Mention of quantity or urgency.
    - Seeming like a genuine business inquiry rather than a generic one.
    
    A lower score should be given for:
    - Vague requirements (e.g., "I want product").
    - Missing contact details or location.
    - Seeming like spam or a test inquiry.
    
    Return the response as a JSON array, where each object in the array corresponds to an original lead and includes the original lead data plus the new 'potentialScore' and 'analysis' fields.
    
    Here is the list of leads:
    ${JSON.stringify(leads.map(lead => ({
      leadId: lead.leadId,
      companyName: lead.companyName,
      enquiryTitle: lead.enquiryTitle,
      requirement: lead.requirement,
      contactInfo: lead.contactInfo,
      location: lead.location,
      timestamp: lead.timestamp,
      quantity: lead.quantity,
      category: lead.category,
      probableOrderValueMin: lead.probableOrderValueMin,
      probableOrderValueMax: lead.probableOrderValueMax,
      potentialScore: undefined,
      analysis: undefined
    })), null, 2)}
  `;

  console.log('[Gemini Service] Preparing prompt for Gemini API...');
  console.log('[Gemini Service] Leads being sent to Gemini:', leads.map(lead => ({
    company: lead.companyName,
    enquiry: lead.enquiryTitle,
    requirement: lead.requirement.substring(0, 50) + '...'
  })));

  console.log('[Gemini Service] Sending request to Gemini API...');
  
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              companyName: { type: Type.STRING },
              requirement: { type: Type.STRING },
              contactInfo: { type: Type.STRING },
              location: { type: Type.STRING },
              timestamp: { type: Type.STRING },
              potentialScore: { 
                type: Type.INTEGER,
                description: "A score from 1 to 100 representing the lead's potential."
              },
              analysis: { 
                type: Type.STRING,
                description: "A brief analysis (max 20 words) explaining the score."
              },
            },
          },
        },
      },
    });

    console.log('[Gemini Service] Received response from Gemini API');
    const text = (response as any)?.text as string | undefined;
    console.log('[Gemini Service] Raw response text:', text);
    
    if (!text) {
      throw new Error("Empty response from AI model.");
    }
    
    const analyzedData = JSON.parse(text);
    console.log('[Gemini Service] Parsed Gemini response:', analyzedData);
    
    if (!Array.isArray(analyzedData)) {
      throw new Error("AI response format is incorrect or mismatched length.");
    }
    const merged = leads.map(original => {
      const aiLead = analyzedData.find((item: any) => item.leadId === original.leadId || item.companyName === original.companyName);
      if (aiLead) {
        return {
          ...original,
          potentialScore: typeof aiLead.potentialScore === 'number' ? aiLead.potentialScore : original.potentialScore,
          analysis: typeof aiLead.analysis === 'string' ? aiLead.analysis : original.analysis,
        };
      }
      return original;
    });
    console.log('[Gemini Service] Successfully merged Gemini analysis with leads');
    console.log('[Gemini Service] Final analyzed leads:', merged.map(l => ({
      company: l.companyName,
      score: l.potentialScore,
      analysis: l.analysis
    })));
    
    return merged.sort((a, b) => (b.potentialScore || 0) - (a.potentialScore || 0));
  } catch (e) {
    console.error("[Gemini Service] Failed to merge Gemini results:", e);
    throw new Error("Could not parse the analysis from the AI. The response was not valid JSON.");
  }
}

export async function filterLeadsWithGemini(leads: Lead[]): Promise<Lead[]> {
  console.log('[Gemini Filter] Starting lead filtering...');
  console.log(`[Gemini Filter] Number of leads to filter: ${leads.length}`);
  
  if (leads.length === 0) {
    console.log('[Gemini Filter] No leads to filter, returning empty array');
    return leads;
  }

  const prompt = `
    You are an assistant helping a uniform manufacturer filter IndiaMART leads. Apply these rules strictly:
    1. TITLE keywords required (case-insensitive match anywhere in enquiryTitle or requirement): ${TITLE_KEYWORDS.join(', ')}.
    2. Exclude leads from these locations or any foreign country: ${EXCLUDED_LOCATIONS.join(', ')}.
       Prefer northern Indian cities (examples: ${PREFERRED_LOCATIONS.join(', ')}).
    3. Minimum quantity > 100 units.
    4. Category (“I am interested in”) must exactly match one of: ${CATEGORY_ALLOW_LIST.join(', ')}.
    5. Probable order value must be greater than ₹50,000.

    For each lead, respond with JSON containing:
      - leadId
      - isQualified (boolean)
      - reason (string explaining decision)
      - nextContactDelayMinutes (one of 1, 5, 10)

    Leads array:
    ${JSON.stringify(leads.map(lead => ({
      leadId: lead.leadId,
      enquiryTitle: lead.enquiryTitle,
      requirement: lead.requirement,
      location: lead.location,
      quantity: lead.quantity,
      category: lead.category,
      probableOrderValueMin: lead.probableOrderValueMin,
      probableOrderValueMax: lead.probableOrderValueMax
    })), null, 2)}
  `;

  console.log('[Gemini Filter] Preparing prompt for Gemini API...');
  console.log('[Gemini Filter] Leads being sent to Gemini:', leads.map(lead => ({
    company: lead.companyName,
    enquiry: lead.enquiryTitle,
    requirement: lead.requirement.substring(0, 50) + '...'
  })));

  try {
    console.log('[Gemini Filter] Sending filtering request to Gemini API...');
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              leadId: { type: Type.STRING },
              isQualified: { type: Type.BOOLEAN },
              reason: { type: Type.STRING },
              nextContactDelayMinutes: { type: Type.INTEGER },
            },
          },
        },
      },
    });

    console.log('[Gemini Filter] Received filtering response from Gemini API');
    const text = (response as any)?.text as string | undefined;
    console.log('[Gemini Filter] Raw filter response:', text);
    
    if (!text) {
      throw new Error("Empty response from AI model.");
    }
    
    const filteredData = JSON.parse(text);
    console.log('[Gemini Filter] Parsed filter response:', filteredData);
    
    if (!Array.isArray(filteredData)) {
      throw new Error('AI filter response must be an array.');
    }

    let delayCursor = 0;
    return leads.map(lead => {
      const match = filteredData.find((item: any) => item.leadId === lead.leadId);
      if (match) {
        const heuristic = evaluateLeadHeuristically(lead, delayCursor++);
        const isQualified = Boolean(match.isQualified) && heuristic.isQualified;
        return {
          ...lead,
          passedFilter: isQualified,
          filterReason: isQualified ? 'Qualified by Gemini + heuristics.' : `${match.reason || 'Filtered out by Gemini.'} ${heuristic.reason}`.trim(),
          nextContactDelayMinutes: normalizeDelay(match.nextContactDelayMinutes ?? heuristic.delay),
        };
      }
      const heuristic = evaluateLeadHeuristically(lead, delayCursor++);
      return {
        ...lead,
        passedFilter: heuristic.isQualified,
        filterReason: heuristic.reason,
        nextContactDelayMinutes: heuristic.delay,
      };
    });
  } catch (e) {
    console.error("[Gemini Filter] Gemini filtering failed, falling back to heuristic filtering:", e);
    let delayCursor = 0;
    return leads.map(lead => {
      const heuristic = evaluateLeadHeuristically(lead, delayCursor++);
      return {
        ...lead,
        passedFilter: heuristic.isQualified,
        filterReason: heuristic.reason,
        nextContactDelayMinutes: heuristic.delay,
      };
    });
  }
}
