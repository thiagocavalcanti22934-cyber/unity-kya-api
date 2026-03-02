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
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_BUCKET || "kyc";

    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing Supabase env vars" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const formData = await req.formData();
    const unityDealId = formData.get("unity_deal_id");

    if (!unityDealId || !/^UNITY-\d+$/.test(unityDealId)) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid unity_deal_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    async function uploadOne(fieldName, folderName) {
      const file = formData.get(fieldName);
      if (!(file instanceof File) || file.size === 0) {
        return null;
      }

      // Safe-ish filename
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

      return path;
    }

    const proofOfIdPath = await uploadOne("proof_of_id", "proof_of_id");
    const proofOfAddressPath = await uploadOne("proof_of_address", "proof_of_address");
    const proofOfFundsPath = await uploadOne("proof_of_funds", "proof_of_funds");

    return new Response(
      JSON.stringify({
        ok: true,
        unity_deal_id: unityDealId,
        uploaded: {
          proof_of_id: proofOfIdPath,
          proof_of_address: proofOfAddressPath,
          proof_of_funds: proofOfFundsPath,
        },
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
