export async function POST(req) {
  try {
    const formData = await req.formData();

    const unityDealId = formData.get("unity_deal_id");

    const proofOfId = formData.get("proof_of_id");
    const proofOfAddress = formData.get("proof_of_address");
    const proofOfFunds = formData.get("proof_of_funds");

    return new Response(
      JSON.stringify({
        ok: true,
        received: {
          unity_deal_id: unityDealId,
          proof_of_id: proofOfId?.name || null,
          proof_of_address: proofOfAddress?.name || null,
          proof_of_funds: proofOfFunds?.name || null,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function GET() {
  return new Response(
    JSON.stringify({ ok: false, error: "Use POST" }),
    { status: 405, headers: { "Content-Type": "application/json" } }
  );
}
