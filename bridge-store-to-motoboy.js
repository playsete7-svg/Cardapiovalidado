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
    storeAddress: runtime.storeAddress || STORE_IDENTITY.storeAddress || order.storeAddress || order.storeSnapshot?.address,
    storeLat: runtime.storeLat ?? STORE_IDENTITY.storeLat ?? order.storeLatitude ?? order.storeSnapshot?.latitude ?? order.storeSnapshot?.lat,
    storeLng: runtime.storeLng ?? STORE_IDENTITY.storeLng ?? order.storeLongitude ?? order.storeSnapshot?.longitude ?? order.storeSnapshot?.lng,
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
function routePoint(value) {
  const source = value?.coords || value || {};
  const latitude = Number(source.latitude ?? source.lat ?? source.lastLatitude);
  const longitude = Number(source.longitude ?? source.lng ?? source.lon ?? source.lastLongitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}
function haversineKm(a, b) {
  const first = routePoint(a), second = routePoint(b);
  if (!first || !second) return null;
  const radians = Math.PI / 180;
  const dLat = (second.latitude - first.latitude) * radians;
  const dLng = (second.longitude - first.longitude) * radians;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(first.latitude * radians) * Math.cos(second.latitude * radians) * Math.sin(dLng / 2) ** 2;
  return Number((6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)))).toFixed(2));
}
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
      address: order.addressSnapshot?.street || order.addressSnapshot?.address || order.deliveryAddressBase || order.address || order.deliveryAreaName || "",
      complement: order.addressSnapshot?.complement || order.deliveryHouseNumber || "",
      reference: order.addressSnapshot?.reference || "",
      lat: order.addressSnapshot?.lat ?? order.deliveryLatitude ?? order.deliveryLocation?.latitude ?? null,
      lng: order.addressSnapshot?.lng ?? order.deliveryLongitude ?? order.deliveryLocation?.longitude ?? null,
      customerName: order.customerSnapshot?.name || order.userName || "",
      customerPhone: order.customerSnapshot?.phone || order.userPhone || "",
    },
    // A Central calcula a rota e a remuneração. A loja não envia taxa, preço ou valor por km.
    logistics: {
      dispatchMode: order.dispatchMode || "marketplace",
      pricingAuthority: 'motoboy_central',
      estimatedDistance: null,
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

const activePartnerSearches = new Map();
function partnerPickerState(list, title, detail='') { if (!list) return; list.innerHTML = `<div class="partner-search-state" role="status"><span class="partner-search-spinner" aria-hidden="true"></span><strong>${title}</strong><small>${detail}</small></div>`; }
function partnerPickerConnected(list, name) { if (!list) return; list.innerHTML = `<div class="partner-connected-state" role="status"><span class="partner-connected-mark">✓</span><strong>Motoboy conectado</strong><small>${name || 'O parceiro'} aceitou a corrida e já está vinculado ao pedido.</small></div>`; }
async function waitForPartnerRide(order, rideId, modal, list) {
  let attempts = 0;
  const timer = setInterval(async () => {
    try {
      const ride = window.supremoRestReadDocument ? await window.supremoRestReadDocument(MOTOBOY_CFG.projectId, MOTOBOY_CFG.apiKey, 'rides', rideId) : null;
      if (!ride) return;
      const status = String(ride.status || '').toLowerCase();
      const courierId = String(ride.selectedCourierId || '').trim();
      const courierName = ride.selectedCourierName || ride.offerCourierName || '';
      if (status === 'accepted' || courierId) {
        clearInterval(timer); activePartnerSearches.delete(String(order.id));
        if (window.db && window.updateDoc && window.doc) {
          await window.updateDoc(window.doc(window.db, 'orders', String(order.id)), { status:'out_for_delivery', motoboyId:courierId, motoboyName:courierName, deliveryDispatchStatus:'accepted', deliveryPartnerConnectedAt:new Date().toISOString(), deliveryOffer:{status:'accepted',rideId,motoboyId:courierId,motoboyName:courierName,acceptedAt:ride.deliveryAcceptedAt || new Date().toISOString()}, updatedAt:new Date().toISOString() });
        }
        partnerPickerConnected(list, courierName);
        if (typeof window.renderAdminOrders === 'function') window.renderAdminOrders();
        setTimeout(() => { if (modal) modal.classList.remove('open'); }, 1400);
        return;
      }
      if (['cancelled','delivered'].includes(status)) { clearInterval(timer); activePartnerSearches.delete(String(order.id)); partnerPickerState(list, 'Busca encerrada', 'O pedido foi encerrado antes do aceite do motoboy.'); return; }
      if (status === 'ready_for_dispatch' && ride.declinedAt) partnerPickerState(list, 'Buscando outro motoboy', 'O parceiro recusou a corrida. A Central continuará procurando disponibilidade.');
    } catch (error) { console.warn('[Bridge2] Consulta do aceite indisponível:', error?.message || error); }
    attempts += 1;
    if (attempts >= 180) { clearInterval(timer); activePartnerSearches.delete(String(order.id)); partnerPickerState(list, 'Ainda procurando', 'A busca continua na Central. Feche este painel ou aguarde uma nova atualização.'); }
  }, 4000);
  return timer;
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
  modal.classList.add('open');
  const key = String(order.id);
  if (activePartnerSearches.has(key)) { partnerPickerState(list, 'Buscando motoboy', 'A oferta já está em análise pela Central.'); return; }
  partnerPickerState(list, 'Buscando motoboy', 'A Central está localizando um parceiro disponível e calculando a corrida.');
  activePartnerSearches.set(key, true);
  await offerPartnerCourier(order);
}
async function offerPartnerCourier(order) {
  const modal = document.getElementById('partnerMotoboyModal');
  const list = document.getElementById('partnerMotoboyList');
  const rideId = `ride_${order.id}`;
  try {
    const created = await requestMarketplaceCourier({ ...order, dispatchMode: order.dispatchMode || 'hybrid' });
    if (!created.ok) throw new Error(created.error || 'Corrida não criada');
    const now = new Date().toISOString();
    const centralRideId = created.rideId || rideId;
    await (window.supremoRestMergeWrite || supremoRestWrite)(MOTOBOY_CFG.projectId, MOTOBOY_CFG.apiKey, 'rides', centralRideId, { storeSelectionRequested: true, storeSelectionMode: 'automatic', pricingAuthority: 'motoboy_central', storeSearchStartedAt: now, updatedAt: now });
    if (window.db && window.updateDoc && window.doc) await window.updateDoc(window.doc(window.db, 'orders', String(order.id)), { deliveryPartnerCandidateId: null, deliveryPartnerCandidateName: null, deliveryDispatchStatus: 'searching_motoboy', 'deliveryOffer.status': 'searching_motoboy', 'deliveryOffer.rideId': centralRideId, 'deliveryOffer.searchStartedAt': now, updatedAt: now });
    partnerPickerState(list, 'Buscando motoboy', 'A oferta foi enviada à Central. O pedido será conectado somente após o aceite.');
    await waitForPartnerRide(order, centralRideId, modal, list);
  } catch (error) {
    activePartnerSearches.delete(String(order.id));
    console.error('[Bridge2] Falha ao buscar parceiro:', error);
    partnerPickerState(list, 'Não foi possível iniciar a busca', 'Tente novamente quando o pedido estiver pronto para entrega.');
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
