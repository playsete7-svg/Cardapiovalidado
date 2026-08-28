/**
 * BRIDGE 3: Loja ← Central de Motoboys (Listener de Status)
 * ===========================================================
 * Problema: Quando o motoboy aceita a corrida, chega na loja,
 *   sai para entrega, ou finaliza, o status do pedido na loja
 *   nao atualiza. A loja nao escuta a colecao rides da central.
 *
 * Solucao: A loja inicializa um app Firebase secundario conectado
 *   a central-de-motoboy e escuta onSnapshot da colecao rides,
 *   filtrando apenas as corridas desta loja (storeId = STORE_ID).
 *   Quando o status muda, atualiza o pedido local.
 *
 * INTEGRACAO:
 *   No Lojas.html, apos a inicializacao do Firebase principal,
 *   adicionar: `initMotoboyRideListener();`
 *
 *   E importar antes do script principal:
 *   <script src="supremo-bridge-config.js"></script>
 *   <script src="bridge-store-to-motoboy.js"></script>
 *   <script src="bridge-store-motoboy-listener.js"></script>
 */

// Mapa de status da central → status do pedido na loja
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

// Controla se o listener ja foi iniciado
let motoboyRideUnsubscribe = null;
let motoboyBridgeApp = null;
let motoboyBridgeDb = null;

/**
 * Inicializa o listener de corridas da central de motoboys.
 * Usa um app Firebase secundario para nao conflitar com o app principal da loja.
 */
async function initMotoboyRideListener() {
  if (motoboyRideUnsubscribe) {
    console.log("[Bridge3] Listener ja ativo");
    return;
  }

  try {
    // Importar Firebase dinamicamente (usa v12 como os outros modulos)
    const { initializeApp, getFirestore, collection, query, where, onSnapshot } = await import(
      "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js"
    ).then(app => ({
      initializeApp: app.initializeApp,
      ...await import("https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js")
    }));

    // Criar app secundario para a central de motoboys
    motoboyBridgeApp = initializeApp(SUPREMO_BRIDGE_CONFIG.motoboy, "motoboy-bridge");
    motoboyBridgeDb = getFirestore(motoboyBridgeApp);

    // Escutar apenas corridas desta loja
    const ridesRef = query(
      collection(motoboyBridgeDb, "rides"),
      where("storeId", "==", STORE_IDENTITY.storeId)
    );

    motoboyRideUnsubscribe = onSnapshot(
      ridesRef,
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added" || change.type === "modified") {
            handleRideUpdate(change.doc.data(), change.type);
          }
        });
      },
      (error) => {
        console.warn("[Bridge3] Erro no listener de corridas:", error);
        // Tentar reconectar apos 10s
        setTimeout(() => {
          if (motoboyRideUnsubscribe) {
            motoboyRideUnsubscribe();
            motoboyRideUnsubscribe = null;
            initMotoboyRideListener();
          }
        }, 10000);
      }
    );

    console.log("[Bridge3] Listener de corridas ativado para loja:", STORE_IDENTITY.storeId);
  } catch (error) {
    console.error("[Bridge3] Falha ao iniciar listener:", error);
    // Fallback: polling via REST a cada 15s
    startRidePolling();
  }
}

/**
 * Processa atualizacao de status de uma corrida e atualiza o pedido na loja.
 */
async function handleRideUpdate(ride, changeType) {
  const orderId = String(ride.orderId || "");
  const rideStatus = String(ride.status || "");
  const mapping = RIDE_STATUS_MAP[rideStatus];

  if (!mapping || !orderId) {
    console.log("[Bridge3] Status sem mapeamento:", rideStatus, "para pedido", orderId);
    return;
  }

  console.log(`[Bridge3] Corrida ${ride.id} → ${rideStatus} (${mapping.label}) para pedido ${orderId}`);

  // Atualizar o pedido no Firestore da loja
  try {
    if (typeof window !== "undefined" && window.db) {
      const { doc, updateDoc, serverTimestamp } = await import(
        "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js"
      );

      const update = {
        "logistics.status": mapping.logisticsStatus,
        "logistics.rideId": ride.id || null,
        "logistics.courierId": ride.selectedCourierId || null,
        "logistics.courierName": ride.selectedCourierName || null,
        "deliveryOffer.status": rideStatus,
        "deliveryOffer.courierId": ride.selectedCourierId || null,
        "deliveryOffer.courierName": ride.selectedCourierName || null,
        updatedAt: new Date(),
      };

      // So mudar o status principal do pedido em transicoes importantes
      if (["in_transit", "delivered", "cancelled", "cancellation_requested", "exception"].includes(rideStatus)) {
        update.status = mapping.orderStatus;

        // Adicionar ao historico
        update.statusHistory = [...(await getOrderHistory(orderId)), {
          at: Date.now(),
          status: mapping.orderStatus,
          message: mapping.label + (ride.selectedCourierName ? ` — Motoboy: ${ride.selectedCourierName}` : ""),
        }];

        // Marcar deliveredAt se entregue
        if (rideStatus === "delivered") {
          update.deliveredAt = new Date();
        }
      }

      await updateDoc(doc(window.db, "orders", orderId), update);
    }
  } catch (error) {
    console.warn("[Bridge3] Nao foi possivel atualizar pedido local:", error);
  }

  // Notificar a UI (se a loja tiver um sistema de notificacao)
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("supremo:ride-update", {
      detail: { orderId, rideId: ride.id, status: rideStatus, label: mapping.label, courier: ride.selectedCourierName }
    }));
  }

  // Publicar evento no gestor (apenas em transicoes importantes)
  if (["accepted", "in_transit", "delivered", "cancelled"].includes(rideStatus)) {
    await supremoPublishEvent(
      "delivery",
      `ride_${rideStatus}`,
      rideStatus === "delivered" ? "info" : rideStatus === "cancelled" ? "warning" : "info",
      `Corrida ${ride.id} ${mapping.label} — Pedido ${orderId}`,
      ride.id,
      { orderId, storeId: STORE_IDENTITY.storeId, courierId: ride.selectedCourierId }
    );
  }
}

/**
 * Le o historico atual do pedido (helper).
 */
async function getOrderHistory(orderId) {
  try {
    const { doc, getDoc } = await import(
      "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js"
    );
    const snap = await getDoc(doc(window.db, "orders", String(orderId)));
    if (snap.exists()) {
      return snap.data().statusHistory || [];
    }
  } catch (e) {
    console.warn("[Bridge3] Erro ao ler historico:", e);
  }
  return [];
}

/**
 * Fallback: polling de corridas via REST a cada 15s
 * (usado se o SDK secundario falhar)
 */
function startRidePolling() {
  console.log("[Bridge3] Iniciando polling de corridas (fallback)");
  let lastUpdate = {};

  setInterval(async () => {
    try {
      const rides = await supremoRestReadCollection(
        MOTOBOY_CFG.projectId,
        MOTOBOY_CFG.apiKey,
        "rides"
      );

      for (const ride of rides) {
        if (ride.storeId !== STORE_IDENTITY.storeId) continue;
        const updateKey = `${ride.id}:${ride.status}:${ride.updatedAt}`;
        if (lastUpdate[ride.id] === updateKey) continue;
        lastUpdate[ride.id] = updateKey;
        handleRideUpdate(ride, "modified");
      }
    } catch (e) {
      console.warn("[Bridge3] Polling falhou:", e);
    }
  }, 15000);
}

/**
 * Para o listener (se necessario).
 */
function stopMotoboyRideListener() {
  if (motoboyRideUnsubscribe) {
    motoboyRideUnsubscribe();
    motoboyRideUnsubscribe = null;
    console.log("[Bridge3] Listener parado");
  }
}

if (typeof window !== "undefined") {
  window.initMotoboyRideListener = initMotoboyRideListener;
  window.stopMotoboyRideListener = stopMotoboyRideListener;
  window.RIDE_STATUS_MAP = RIDE_STATUS_MAP;
}
