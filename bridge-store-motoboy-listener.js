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
let rideLastSeen = {};

/**
 * Inicia o polling de corridas da central de motoboys via REST API.
 * Nao depende do Firebase SDK — usa fetch direto.
 */
function initMotoboyRideListener() {
  if (ridePollingActive) return;
  ridePollingActive = true;
  console.log("[Bridge3] Listener REST de corridas ativado para loja:", (window.STORE_IDENTITY || {}).storeId);

  setInterval(async () => {
    try {
      const cfg = window.SUPREMO_BRIDGE_CONFIG?.motoboy;
      if (!cfg || !cfg.apiKey || !cfg.projectId) return;

      // Buscar todas as rides da central via REST
      const storeId = (window.STORE_IDENTITY || {}).storeId;
      const url = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents:runQuery?key=${cfg.apiKey}`;
      const queryBody = {
        structuredQuery: {
          from: [{ collectionId: "rides" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "storeId" },
              op: "EQUAL",
              value: { stringValue: storeId }
            }
          },
          limit: 50
        }
      };

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(queryBody)
      });

      if (!response.ok) return;
      const results = await response.json();

      for (const row of results) {
        if (!row.document) continue;
        const docFields = row.document.fields || {};
        const ride = window.supremoFirestoreVal({ mapValue: { fields: docFields } });
        ride.id = String(row.document.name || "").split("/").pop();

        const rideStatus = String(ride.status || "");
        const orderId = String(ride.orderId || "");
        if (!orderId || !rideStatus) continue;

        const updateKey = `${ride.id}:${rideStatus}:${ride.updatedAt || ride.timeline?.slice(-1)?.[0]?.at}`;
        if (rideLastSeen[ride.id] === updateKey) continue;
        rideLastSeen[ride.id] = updateKey;

        handleRideUpdate(ride);
      }
    } catch (e) {
      // Silencioso — vai tentar de novo no proximo ciclo
    }
  }, 5000);
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

  // Atualizar o pedido no Firestore da loja usando o SDK da loja (v9.1.0)
  try {
    if (typeof window !== "undefined" && window.db && window.doc && window.updateDoc) {
      const update = {
        "logistics.status": mapping.logisticsStatus,
        "logistics.rideId": ride.id || null,
        "logistics.courierId": ride.selectedCourierId || null,
        "logistics.courierName": ride.selectedCourierName || null,
        "deliveryOffer.status": rideStatus,
        "deliveryOffer.courierId": ride.selectedCourierId || null,
        "deliveryOffer.courierName": ride.selectedCourierName || null,
        updatedAt: new Date().toISOString(),
      };

      // So mudar o status principal em transicoes importantes
      if (["in_transit", "delivered", "cancelled", "cancellation_requested", "exception"].includes(rideStatus)) {
        update.status = mapping.orderStatus;
        if (rideStatus === "delivered") {
          update.deliveredAt = new Date().toISOString();
        }

        // Adicionar notificacao ao cliente
        if (rideStatus === "in_transit" && ride.selectedCourierName) {
          update.customerNotification = {
            type: "out_for_delivery",
            title: "Pedido saiu para entrega",
            message: `O motoboy ${ride.selectedCourierName} já saiu para entregar o seu pedido.`,
            createdAt: new Date().toISOString(),
            read: false
          };
        }
        if (rideStatus === "delivered") {
          update.customerNotification = {
            type: "order_delivered",
            title: "Pedido entregue",
            message: "Seu pedido foi entregue. Obrigado!",
            createdAt: new Date().toISOString(),
            read: false
          };
        }
      }

      await window.updateDoc(window.doc(window.db, "orders", orderId), update);
    }
  } catch (error) {
    console.warn("[Bridge3] Nao foi possivel atualizar pedido local:", error);
  }

  // Notificar a UI
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("supremo:ride-update", {
      detail: { orderId, rideId: ride.id, status: rideStatus, label: mapping.label, courier: ride.selectedCourierName }
    }));
  }

  // Publicar evento no gestor
  if (["accepted", "in_transit", "delivered", "cancelled"].includes(rideStatus) && window.supremoPublishEvent) {
    try {
      await window.supremoPublishEvent(
        "delivery", `ride_${rideStatus}`,
        rideStatus === "cancelled" ? "warning" : "info",
        `Corrida ${ride.id} ${mapping.label} — Pedido ${orderId}`,
        ride.id,
        { orderId, storeId: (window.STORE_IDENTITY || {}).storeId, courierId: ride.selectedCourierId }
      );
    } catch (e) { /* silencioso */ }
  }
}

function stopMotoboyRideListener() {
  ridePollingActive = false;
  console.log("[Bridge3] Listener parado");
}

if (typeof window !== "undefined") {
  window.initMotoboyRideListener = initMotoboyRideListener;
  window.stopMotoboyRideListener = stopMotoboyRideListener;
  window.RIDE_STATUS_MAP = RIDE_STATUS_MAP;
}
