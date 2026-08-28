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
  storeAddress: "",
  storeLat: null,
  storeLng: null,
  storePhone: "",
};

function configureStoreIdentity(patch = {}) {
  Object.assign(STORE_IDENTITY, patch || {});
  STORE_IDENTITY.storeId = String(STORE_IDENTITY.storeId || "").trim();
  STORE_IDENTITY.storeName = String(STORE_IDENTITY.storeName || "Loja parceira").trim();
  if (typeof window !== "undefined") window.STORE_IDENTITY = STORE_IDENTITY;
  return STORE_IDENTITY;
}

function currentStoreIdentity(order = {}) {
  const runtime = (typeof window !== "undefined" && window.SUPREMO_STORE_IDENTITY) || {};
  return configureStoreIdentity({
    ...runtime,
    storeId: runtime.storeId || STORE_IDENTITY.storeId || order.storeId,
    storeName: runtime.storeName || STORE_IDENTITY.storeName || order.storeSnapshot?.name,
    storeAddress: runtime.storeAddress || STORE_IDENTITY.storeAddress,
    storeLat: runtime.storeLat ?? STORE_IDENTITY.storeLat,
    storeLng: runtime.storeLng ?? STORE_IDENTITY.storeLng,
    storePhone: runtime.storePhone || STORE_IDENTITY.storePhone || order.storeSnapshot?.whatsapp,
  });
}

/**
 * Cria uma corrida no Firebase da Central de Motoboys
 * quando a loja precisa de um entregador do marketplace.
 *
 * @param {Object} order - O pedido pronto para entrega
 * @returns {Promise<{ok: boolean, rideId?: string, error?: string}>}
 */
async function requestMarketplaceCourier(order) {
  if (!order?.id) return { ok: false, error: "Pedido sem identificador" };
  const identity = currentStoreIdentity(order);
  const rideId = `ride_${order.id}`;
  const now = new Date().toISOString();
  if (window.supremoRestReadDocument) {
    try {
      const existing = await window.supremoRestReadDocument(MOTOBOY_CFG.projectId, MOTOBOY_CFG.apiKey, "rides", rideId);
      if (existing && !["cancelled", "delivered"].includes(String(existing.status || ""))) {
        if (window.db && window.doc && window.updateDoc) {
          await window.updateDoc(window.doc(window.db, "orders", String(order.id)), {
            "logistics.rideId": rideId,
            "logistics.status": `ride_${existing.status || "created"}`,
            "deliveryOffer.rideId": rideId,
            updatedAt: now,
          });
        }
        return { ok: true, rideId, reused: true };
      }
    } catch (error) { console.warn("[Bridge2] Verificação da corrida existente falhou:", error?.message || error); }
  }

  // Dados minimos que a central precisa para despachar
  // NAO enviamos itens, valores comerciais, nem dados de pagamento
  // A central so precisa: de onde buscar, para onde entregar, e quem
  const ride = {
    id: rideId,
    orderId: String(order.id),
    orderPublicCode: order.publicCode || "",
    storeId: identity.storeId,
    storeName: identity.storeName,
    storePhone: identity.storePhone || "",
    status: "ready_for_dispatch",
    // Endereco de coleta (loja)
    pickup: {
      address: identity.storeAddress || "",
      lat: identity.storeLat || null,
      lng: identity.storeLng || null,
      storeName: identity.storeName,
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
      message: `Corrida criada por ${identity.storeName} para pedido ${order.publicCode || order.id}`,
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
    // USAR window.doc/window.updateDoc (SDK v9 da loja) — NAO importar v12
    if (typeof window !== "undefined" && window.db && window.doc && window.updateDoc) {
      try {
        await window.updateDoc(window.doc(window.db, "orders", String(order.id)), {
          "logistics.rideId": rideId,
          "logistics.status": "ride_created",
          "deliveryOffer.status": "marketplace_requested",
          "deliveryOffer.rideId": rideId,
          "deliveryOffer.requestedAt": now,
          updatedAt: now,
        });
        console.log("[Bridge2] Pedido local atualizado com rideId:", rideId);
      } catch (e) {
        console.warn("[Bridge2] Nao foi possivel atualizar pedido local:", e);
      }
    }

    // Replicar status do pedido para Gestor e CRM
    if (window.syncOrderStatusToGestorAndCRM) {
      try { await window.syncOrderStatusToGestorAndCRM(order.id, "ready_for_delivery", order); } catch (e) {}
    }

    // Publicar evento no gestor
    await supremoPublishEvent(
      "delivery",
      "ride_created",
      "info",
      `Corrida ${rideId} criada para entrega do pedido ${order.publicCode || order.id}`,
      rideId,
      { storeId: identity.storeId, orderId: order.id }
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
      { storeId: identity.storeId, error: error.message }
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


async function fetchPartnerMotoboys() {
  const cfg = SUPREMO_BRIDGE_CONFIG.motoboy;
  if (!cfg?.projectId || !cfg?.apiKey || !window.supremoRestReadCollection) return [];
  try {
    const rows = await window.supremoRestReadCollection(cfg.projectId, cfg.apiKey, 'motoboys');
    const now = Date.now();
    return rows.filter(item => {
      const status = String(item.status || item.presence || '').toLowerCase();
      const seen = item.lastSeenAt ? Date.parse(item.lastSeenAt) : now;
      return item.active !== false && item.accountStatus !== 'suspended' && item.isOnline === true && ['disponivel','available','online'].includes(status) && (!Number.isFinite(seen) || now - seen < 20 * 60 * 1000);
    }).map(item => ({ ...item, partner: true }));
  } catch (error) {
    console.warn('[Bridge2] Não foi possível consultar motoboys parceiros:', error?.message || error);
    return [];
  }
}

function closePartnerMotoboyPicker() {
  const modal = document.getElementById('partnerMotoboyModal');
  if (modal) modal.classList.remove('open');
}

async function openPartnerMotoboyPicker(orderId) {
  const order = (Array.isArray(window.orders) ? window.orders : []).find(item => String(item.id) === String(orderId));
  const modal = document.getElementById('partnerMotoboyModal');
  const list = document.getElementById('partnerMotoboyList');
  if (!order || !modal || !list) return;
  list.innerHTML = '<div class="empty-list">Buscando motoboys parceiros disponíveis…</div>';
  modal.classList.add('open');
  const partners = await fetchPartnerMotoboys();
  if (!partners.length) {
    list.innerHTML = '<div class="empty-list"><b>Nenhum parceiro disponível agora</b>Os motoboys parceiros precisam estar aprovados e online na Central.</div>';
    return;
  }
  list.innerHTML = partners.map(item => `<button type="button" class="partner-motoboy-option" data-partner-id="${String(item.id).replace(/[^a-zA-Z0-9_-]/g, '')}"><span class="partner-avatar">${String(item.name || 'M').slice(0, 1).toUpperCase()}</span><span><b>${String(item.name || 'Motoboy parceiro').replace(/[&<>"']/g, '')}</b><small>${String(item.vehicleType || item.vehicleModel || 'Veículo não informado').replace(/[&<>"']/g, '')} · Disponível</small></span><strong>Oferecer</strong></button>`).join('');
  list.querySelectorAll('[data-partner-id]').forEach(button => button.addEventListener('click', async () => {
    const partner = partners.find(item => String(item.id) === String(button.dataset.partnerId));
    if (partner) await offerPartnerCourier(order, partner);
  }));
}

async function offerPartnerCourier(order, partner) {
  const modal = document.getElementById('partnerMotoboyModal');
  const rideId = `ride_${order.id}`;
  try {
    const created = await requestMarketplaceCourier({ ...order, dispatchMode: order.dispatchMode || 'hybrid' });
    if (!created.ok) throw new Error(created.error || 'Corrida não criada');
    const now = new Date().toISOString();
    const offer = { status: 'offered', motoboyId: String(partner.id), offeredAt: now, source: 'store_partner_selection' };
    await (window.supremoRestMergeWrite || supremoRestWrite)(MOTOBOY_CFG.projectId, MOTOBOY_CFG.apiKey, 'rides', created.rideId || rideId, { status: 'offered', offerCourierId: String(partner.id), offerCourierName: partner.name || '', currentOfferId: `offer_${Date.now()}`, offerExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), deliveryOffer: offer, storeSelectionMode: 'partner', updatedAt: now });
    if (window.db && window.updateDoc && window.doc) await window.updateDoc(window.doc(window.db, 'orders', String(order.id)), { deliveryOffer: offer, deliveryPartnerCandidateId: String(partner.id), deliveryPartnerCandidateName: partner.name || '', updatedAt: now });
    if (modal) modal.classList.remove('open');
    if (typeof window.renderAdminOrders === 'function') window.renderAdminOrders();
    alert(`Oferta enviada para ${partner.name || 'o motoboy parceiro'}. O pedido será liberado após o aceite dele.`);
  } catch (error) {
    console.error('[Bridge2] Falha ao oferecer corrida a parceiro:', error);
    alert('Não foi possível enviar a oferta para este motoboy parceiro.');
  }
}

if (typeof window !== "undefined") {
  window.requestMarketplaceCourier = requestMarketplaceCourier;
  window.cancelMarketplaceRide = cancelMarketplaceRide;
  window.configureStoreIdentity = configureStoreIdentity;
  window.STORE_IDENTITY = STORE_IDENTITY;
  window.fetchPartnerMotoboys = fetchPartnerMotoboys;
  window.openPartnerMotoboyPicker = openPartnerMotoboyPicker;
  window.closePartnerMotoboyPicker = closePartnerMotoboyPicker;
}
