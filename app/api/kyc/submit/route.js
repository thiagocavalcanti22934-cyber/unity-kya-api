import { createClient } from "@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(req) {
  try {
    // --- ENV ---
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_BUCKET || "KYC"; // your bucket name is "KYC"
    const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;

    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing Supabase env vars" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!hubspotToken) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing HUBSPOT_ACCESS_TOKEN" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // --- Read form ---
    const formData = await req.formData();

    const unityDealId = (formData.get("unity_deal_id") || "").toString().trim();
    if (!unityDealId || !/^UNITY-\d+$/.test(unityDealId)) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid unity_deal_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Extra fields (Supabase only) ---
    const rawName = (formData.get("name") || "").toString().trim();
    const email = (formData.get("email") || "").toString().trim();
    const phone = (formData.get("phone") || "").toString().trim();
    const additionalInfo = (formData.get("additional_info") || "").toString().trim();

    // Radio group: you said data-name="title_radio"
    // This will be the key ONLY if the radio inputs have name="title_radio"
    const titleRadio = (formData.get("title_radio") || "").toString().trim();

    // Name = Radio value + space + #name
    const composedName = `${titleRadio}${titleRadio ? " " : ""}${rawName}`.trim();

    if (!rawName || !email || !phone) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing required fields: name/email/phone" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Store submission details (Supabase only)
    const { data: submissionRow, error: submissionErr } = await supabase
      .from("kyc_submissions")
      .insert({
        unity_deal_id: unityDealId,
        name: composedName,
        email,
        phone,
        additional_info: additionalInfo || null,
        submitted_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (submissionErr) {
      throw new Error(`Submission insert failed: ${submissionErr.message}`);
    }

    // --- Upload helper (returns path + signedUrl) ---
    async function uploadOne(fieldName, folderName) {
      const file = formData.get(fieldName);
      if (!(file instanceof File) || file.size === 0) return null;

      const original = (file.name || "file").replace(/[^\w.\-]+/g, "_");
      const path = `kyc/${unityDealId}/${folderName}/${Date.now()}_${original}`;

      const bytes = new Uint8Array(await file.arrayBuffer());

      const { error: upErr } = await supabase.storage
        .from(bucket)
        .upload(path, bytes, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });

      if (upErr) throw new Error(`Upload failed for ${fieldName}: ${upErr.message}`);

      const { error: dbErr } = await supabase.from("kyc_documents").insert({
        unity_deal_id: unityDealId,
        doc_type: folderName,
        storage_path: path,
        uploaded_at: new Date().toISOString(),
      });

      if (dbErr) throw new Error(`DB insert failed for ${fieldName}: ${dbErr.message}`);

      // Signed URL (30 days)
      const expiresIn = 60 * 60 * 24 * 30;
      const { data: signed, error: signErr } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, expiresIn);

      if (signErr) throw new Error(`Signed URL failed for ${fieldName}: ${signErr.message}`);

      return { path, signedUrl: signed.signedUrl };
    }

    // --- 1) Upload to Supabase ---
    const proofOfId = await uploadOne("proof_of_id", "proof_of_id");
    const proofOfAddress = await uploadOne("proof_of_address", "proof_of_address");
    const proofOfFunds = await uploadOne("proof_of_funds", "proof_of_funds");

    // --- 2) Find HubSpot deal by unity_deal_id ---
    const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hubspotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [
              {
                propertyName: "unity_deal_id",
                operator: "EQ",
                value: unityDealId,
              },
            ],
          },
        ],
        properties: ["unity_deal_id"],
        limit: 2,
      }),
    });

    const searchText = await searchRes.text();
    if (!searchRes.ok) {
      throw new Error(`HubSpot search failed: ${searchRes.status} ${searchText}`);
    }

    const searchJson = JSON.parse(searchText);
    const results = Array.isArray(searchJson.results) ? searchJson.results : [];

    if (results.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `No HubSpot deal found for unity_deal_id=${unityDealId}`,
          submission_id: submissionRow?.id || null,
          uploaded: { proof_of_id: proofOfId, proof_of_address: proofOfAddress, proof_of_funds: proofOfFunds },
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (results.length > 1) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Multiple HubSpot deals found for unity_deal_id=${unityDealId}. Must be unique.`,
          submission_id: submissionRow?.id || null,
          uploaded: { proof_of_id: proofOfId, proof_of_address: proofOfAddress, proof_of_funds: proofOfFunds },
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const hubspotDealId = results[0].id;

    // --- 3) Update HubSpot deal properties with SIGNED URLs ---
    const propertiesToUpdate = {};
    if (proofOfId) propertiesToUpdate.kyc_proof_of_id = proofOfId.signedUrl;
    if (proofOfAddress) propertiesToUpdate.kyc_proof_of_address = proofOfAddress.signedUrl;
    if (proofOfFunds) propertiesToUpdate.kyc_proof_of_funds = proofOfFunds.signedUrl;

    const updateRes = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${hubspotDealId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${hubspotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties: propertiesToUpdate }),
    });

    const updateText = await updateRes.text();
    if (!updateRes.ok) {
      throw new Error(`HubSpot update failed: ${updateRes.status} ${updateText}`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        unity_deal_id: unityDealId,
        submission_id: submissionRow?.id || null,
        hubspot_deal_id: hubspotDealId,
        submission_saved_to_supabase: {
          name: composedName,
          email,
          phone,
          additional_info: additionalInfo || null,
        },
        uploaded: {
          proof_of_id: proofOfId,
          proof_of_address: proofOfAddress,
          proof_of_funds: proofOfFunds,
        },
        hubspot_updated_properties: propertiesToUpdate,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}
