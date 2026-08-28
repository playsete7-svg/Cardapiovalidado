/**
 * BRIDGE 2: Loja → Central de Motoboys (Criar Corrida)
 * ======================================================
 * Problema: Quando o pedido fica pronto, a loja atribui motoboy
 *   localmente (deliveryOffer no seu proprio Firestore), mas nunca
 *   cria um documento rides no Firebase central-de-motoboy.
 *   A central fica esperando corridas que nunca chegam.
 *
 * Solucao: Quando o pedido fica pronto (ready_for_delivery) e o
 *   dispatchMode e marketplace ou hybrid, a loja cria um documento
 *   rides/{rideId} em central-de-motoboy via REST API.
 *
 * INTEGRACAO:
 *   No Lojas.html, na funcao que muda o status do pedido para
 *   ready_for_delivery, adicionar:
 *
 *   if (order.dispatchMode === 'marketplace' || order.dispatchMode === 'hybrid') {
 *     await requestMarketplaceCourier(order);
 *   }
 *
 *   E importar antes do script principal:
 *   <script src="supremo-bridge-config.js"></script>
 *   <script src="bridge-store-to-motoboy.js"></script>
 */

// Config da central de motoboys (do arquivo compartilhado)
const MOTOBOY_CFG = SUPREMO_BRIDGE_CONFIG.motoboy;

// Dados da loja atual (deve ser configurado pela loja)
// Em producao, isso vem do firebaseConfig ja existente na loja
const STORE_IDENTITY = {
  storeId: "store-luk123-b1986",
  storeName: "Hamburgueria do Bairro",
  storeAddress: "", // Preencher com o endereco da loja
  storeLat: null,   // Preencher com a latitude
  storeLng: null,   // Preencher com a longitude
  storePhone: "",   // WhatsApp da loja
};

/**
 * Cria uma corrida no Firebase da Central de Motoboys
 * quando a loja precisa de um entregador do marketplace.
 *
 * @param {Object} order - O pedido pronto para entrega
 * @returns {Promise<{ok: boolean, rideId?: string, error?: string}>}
 */
async function requestMarketplaceCourier(order) {
  const rideId = `ride_${order.id}`;
  const now = new Date().toISOString();

  // Dados minimos que a central precisa para despachar
  // NAO enviamos itens, valores comerciais, nem dados de pagamento
  // A central so precisa: de onde buscar, para onde entregar, e quem
  const ride = {
    id: rideId,
    orderId: String(order.id),
    orderPublicCode: order.publicCode || "",
    storeId: STORE_IDENTITY.storeId,
    storeName: STORE_IDENTITY.storeName,
    storePhone: STORE_IDENTITY.storePhone || "",
    status: "ready_for_dispatch",
    // Endereco de coleta (loja)
    pickup: {
      address: STORE_IDENTITY.storeAddress || "",
      lat: STORE_IDENTITY.storeLat || null,
      lng: STORE_IDENTITY.storeLng || null,
      storeName: STORE_IDENTITY.storeName,
    },
    // Endereco de entrega (cliente)
    delivery: {
      address: order.addressSnapshot?.street || order.addressSnapshot?.address || "",
      complement: order.addressSnapshot?.complement || "",
      reference: order.addressSnapshot?.reference || "",
      lat: order.addressSnapshot?.lat || null,
      lng: order.addressSnapshot?.lng || null,
      customerName: order.customerSnapshot?.name || "",
      customerPhone: order.customerSnapshot?.phone || "",
    },
    // Metadados logisticos (nao comerciais)
    logistics: {
      dispatchMode: order.dispatchMode || "marketplace",
      estimatedDistance: null,  // Pode ser calculado pela central
      estimatedDuration: null,
    },
    // Atribuicao do motoboy (preenchido pela central)
    selectedCourierId: null,
    selectedCourierName: null,
    currentOfferId: null,
    offerCourierId: null,
    offerExpiresAt: null,
    // Timeline
    createdAt: now,
    updatedAt: now,
    timeline: [{
      at: now,
      status: "ready_for_dispatch",
      message: `Corrida criada por ${STORE_IDENTITY.storeName} para pedido ${order.publicCode || order.id}`,
    }],
  };

  try {
    const result = await supremoRestWrite(
      MOTOBOY_CFG.projectId,
      MOTOBOY_CFG.apiKey,
      "rides",
      rideId,
      ride
    );

    // Atualizar o pedido na loja com o rideId
    if (typeof window !== "undefined" && window.db) {
      try {
        const { doc, updateDoc, serverTimestamp } = await import(
          "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js"
        );
        await updateDoc(doc(window.db, "orders", String(order.id)), {
          "logistics.rideId": rideId,
          "logistics.status": "ride_created",
          "deliveryOffer.status": "marketplace_requested",
          "deliveryOffer.rideId": rideId,
          "deliveryOffer.requestedAt": now,
          updatedAt: new Date(),
        });
      } catch (e) {
        console.warn("[Bridge2] Nao foi possivel atualizar pedido local:", e);
      }
    }

    // Publicar evento no gestor
    await supremoPublishEvent(
      "delivery",
      "ride_created",
      "info",
      `Corrida ${rideId} criada para entrega do pedido ${order.publicCode || order.id}`,
      rideId,
      { storeId: STORE_IDENTITY.storeId, orderId: order.id }
    );

    console.log("[Bridge2] Corrida criada na central:", rideId);
    return { ok: true, rideId };
  } catch (error) {
    console.error("[Bridge2] Falha ao criar corrida:", error);

    await supremoPublishEvent(
      "delivery",
      "ride_creation_failed",
      "error",
      `Falha ao criar corrida para pedido ${order.id}: ${error.message}`,
      order.id,
      { storeId: STORE_IDENTITY.storeId, error: error.message }
    );

    return { ok: false, error: error.message };
  }
}

/**
 * Cancela uma corrida na central (ex: pedido cancelado pela loja).
 */
async function cancelMarketplaceRide(rideId, reason) {
  const now = new Date().toISOString();
  try {
    await supremoRestWrite(
      MOTOBOY_CFG.projectId,
      MOTOBOY_CFG.apiKey,
      "rides",
      rideId,
      {
        status: "cancelled",
        cancelledAt: now,
        cancelReason: reason || "cancelled_by_store",
        updatedAt: now,
      }
    );
    await supremoPublishEvent("delivery", "ride_cancelled", "warning", `Corrida ${rideId} cancelada pela loja`, rideId, { reason });
    return { ok: true };
  } catch (error) {
    console.error("[Bridge2] Falha ao cancelar corrida:", error);
    return { ok: false, error: error.message };
  }
}

if (typeof window !== "undefined") {
  window.requestMarketplaceCourier = requestMarketplaceCourier;
  window.cancelMarketplaceRide = cancelMarketplaceRide;
  window.STORE_IDENTITY = STORE_IDENTITY;
}
