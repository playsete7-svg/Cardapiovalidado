/**
 * BRIDGE 3: Loja ← Central de Motoboys (Listener de Status) — VERSAO REST
 * ========================================================================
 * Versao anterior usava initializeApp secundario com SDK v12, mas a loja
 * usa SDK v9.1.0. Versoes diferentes do SDK no mesmo app causam conflito.
 * Esta versao usa REST polling (fetch) — sem SDK, sem conflito.
 *
 * A cada 5s, busca rides da central de motoboy onde storeId = esta loja.
 * Quando o status muda, atualiza o pedido na loja via updateDoc do SDK da loja.
 */

const RIDE_STATUS_MAP = {
  "ready_for_dispatch": { orderStatus: "ready_for_delivery", logisticsStatus: "ride_created", label: "Aguardando motoboy" },
  "offered":            { orderStatus: "ready_for_delivery", logisticsStatus: "ride_offered",  label: "Oferecendo ao motoboy" },
  "accepted":           { orderStatus: "ready_for_delivery", logisticsStatus: "courier_assigned", label: "Motoboy aceitou" },
  "at_pickup":          { orderStatus: "ready_for_delivery", logisticsStatus: "courier_at_store", label: "Motoboy chegou na loja" },
  "in_transit":         { orderStatus: "out_for_delivery",   logisticsStatus: "in_transit",    label: "Saiu para entrega" },
  "delivered":          { orderStatus: "delivered",           logisticsStatus: "delivered",     label: "Entregue" },
  "cancel_requested":   { orderStatus: "cancellation_requested", logisticsStatus: "cancel_requested", label: "Cancelamento solicitado" },
  "cancelled":          { orderStatus: "cancelled",           logisticsStatus: "cancelled",    label: "Corrida cancelada" },
  "exception":          { orderStatus: "exception",           logisticsStatus: "exception",     label: "Exceção logística" },
};

let ridePollingActive = false;
let ridePollingTimer = null;
let rideLastSeen = {};

/**
 * Inicia o polling de corridas da central de motoboys via REST API.
 * Nao depende do Firebase SDK — usa fetch direto.
 */
function initMotoboyRideListener() {
  if (ridePollingActive) return;
  ridePollingActive = true;
  console.log("[Bridge3] Listener REST de corridas ativado para loja:", (window.STORE_IDENTITY || {}).storeId);
  const poll = async () => {
    if (!ridePollingActive) return;
    try {
      const cfg = window.SUPREMO_BRIDGE_CONFIG?.motoboy;
      const storeId = String((window.STORE_IDENTITY || {}).storeId || "").trim();
      if (!cfg?.apiKey || !cfg?.projectId || !storeId) return;
      const url = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents:runQuery?key=${cfg.apiKey}`;
      const queryBody = { structuredQuery: { from: [{ collectionId: "rides" }], where: { fieldFilter: { field: { fieldPath: "storeId" }, op: "EQUAL", value: { stringValue: storeId } } }, limit: 50 } };
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(queryBody) });
      if (!response.ok) throw new Error(`Central de motoboys ${response.status}`);
      const results = await response.json();
      for (const row of results) {
        if (!row.document) continue;
        const ride = window.supremoFirestoreVal({ mapValue: { fields: row.document.fields || {} } });
        ride.id = String(row.document.name || "").split("/").pop();
        const rideStatus = String(ride.status || "");
        const orderId = String(ride.orderId || "");
        if (!orderId || !rideStatus) continue;
        const updateKey = `${ride.id}:${rideStatus}:${ride.updatedAt || ride.timeline?.slice(-1)?.[0]?.at || ""}`;
        if (rideLastSeen[ride.id] === updateKey) continue;
        rideLastSeen[ride.id] = updateKey;
        handleRideUpdate(ride);
      }
    } catch (error) {
      console.warn("[Bridge3] Falha temporária ao consultar rides:", error?.message || error);
    } finally {
      if (ridePollingActive) ridePollingTimer = setTimeout(poll, 5000);
    }
  };
  poll();
}

/**
 * Processa atualizacao de status de uma corrida e atualiza o pedido na loja.
 */
async function handleRideUpdate(ride) {
  const orderId = String(ride.orderId || "");
  const rideStatus = String(ride.status || "");
  const mapping = RIDE_STATUS_MAP[rideStatus];
  if (!mapping || !orderId) return;

  console.log(`[Bridge3] Corrida ${ride.id} -> ${rideStatus} (${mapping.label}) para pedido ${orderId}`);
  const courierId = ride.selectedCourierId || ride.offerCourierId || null;
  const courierName = ride.selectedCourierName || ride.offerCourierName || null;
  const update = {
    "logistics.status": mapping.logisticsStatus,
    "logistics.rideId": ride.id || null,
    "logistics.courierId": courierId,
    "logistics.courierName": courierName,
    "deliveryOffer.status": rideStatus,
    "deliveryOffer.courierId": courierId,
    "deliveryOffer.courierName": courierName,
    updatedAt: new Date().toISOString(),
  };
  if (["in_transit", "delivered", "cancelled", "cancellation_requested", "exception"].includes(rideStatus)) {
    update.status = mapping.orderStatus;
    if (rideStatus === "delivered") update.deliveredAt = new Date().toISOString();
    if (rideStatus === "in_transit" && courierName) update.customerNotification = { type: "out_for_delivery", title: "Pedido saiu para entrega", message: `O motoboy ${courierName} já saiu para entregar o seu pedido.`, createdAt: new Date().toISOString(), read: false };
    if (rideStatus === "delivered") update.customerNotification = { type: "order_delivered", title: "Pedido entregue", message: "Seu pedido foi entregue. Obrigado!", createdAt: new Date().toISOString(), read: false };
  }

  try {
    if (typeof window !== "undefined" && window.db && window.doc && window.updateDoc) {
      await window.updateDoc(window.doc(window.db, "orders", orderId), update);
    } else if (window.supremoRestMergeWrite && window.firebaseConfig?.projectId && window.firebaseConfig?.apiKey) {
      await window.supremoRestMergeWrite(window.firebaseConfig.projectId, window.firebaseConfig.apiKey, "orders", orderId, update);
    }
    if (window.syncOrderStatusToGestorAndCRM) {
      try { await window.syncOrderStatusToGestorAndCRM(orderId, mapping.orderStatus, { id: orderId, storeId: (window.STORE_IDENTITY || {}).storeId, logistics: update }); } catch (_) {}
    }
  } catch (error) {
    console.warn("[Bridge3] Nao foi possivel atualizar pedido local:", error);
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("supremo:ride-update", { detail: { orderId, rideId: ride.id, status: rideStatus, label: mapping.label, courier: courierName } }));
  }
  if (["accepted", "in_transit", "delivered", "cancelled"].includes(rideStatus) && window.supremoPublishEvent) {
    try {
      await window.supremoPublishEvent("delivery", `ride_${rideStatus}`, rideStatus === "cancelled" ? "warning" : "info", `Corrida ${ride.id} ${mapping.label} — Pedido ${orderId}`, ride.id, { orderId, storeId: (window.STORE_IDENTITY || {}).storeId, courierId });
    } catch (_) {}
  }
}

function stopMotoboyRideListener() {
  ridePollingActive = false;
  if (ridePollingTimer) { clearTimeout(ridePollingTimer); ridePollingTimer = null; }
  console.log("[Bridge3] Listener parado");
}

if (typeof window !== "undefined") {
  window.initMotoboyRideListener = initMotoboyRideListener;
  window.stopMotoboyRideListener = stopMotoboyRideListener;
  window.RIDE_STATUS_MAP = RIDE_STATUS_MAP;
}
