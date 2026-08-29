/**
 * BRIDGE 4b: Loja → Gestor Geral + Central de Clientes
 * ======================================================
 * Quando a loja muda o status de um pedido, precisa replicar essa
 * mudanca para o Gestor Geral e a Central de Clientes, que leem dos
 * seus proprios Firebases.
 *
 * Tudo via REST API — mesmo padrao da Bridge 1.
 */

const GESTOR_CFG = SUPREMO_BRIDGE_CONFIG.gestor;
const CRM_CFG = SUPREMO_BRIDGE_CONFIG.customers;
const MARKETPLACE_CFG = SUPREMO_BRIDGE_CONFIG.marketplace;
const BRIDGE4B_OUTBOX_KEY = 'supremo_bridge4b_outbox_v1';
function readBridge4bOutbox(){try{const value=JSON.parse(localStorage.getItem(BRIDGE4B_OUTBOX_KEY)||'[]');return Array.isArray(value)?value:[]}catch{return[]}}
function writeBridge4bOutbox(value){try{localStorage.setItem(BRIDGE4B_OUTBOX_KEY,JSON.stringify(value.slice(-100)))}catch(_){} }
function enqueueBridge4b(item){const queue=readBridge4bOutbox();const key=`${item.target}:${item.orderId}:${item.patch.status}`;if(!queue.some(row=>`${row.target}:${row.orderId}:${row.patch.status}`===key))queue.push({...item,queuedAt:Date.now(),attempts:0});writeBridge4bOutbox(queue)}
async function flushBridge4bOutbox(){const queue=readBridge4bOutbox();if(!queue.length)return;const remaining=[];for(const item of queue){try{const target=item.target==='Marketplace'?MARKETPLACE_CFG:item.target==='CRM'?CRM_CFG:GESTOR_CFG;await (window.supremoRestMergeWrite||supremoRestWrite)(target.projectId,target.apiKey,'orders',item.orderId,item.patch)}catch(error){remaining.push({...item,attempts:Number(item.attempts||0)+1,lastError:error?.message||String(error)})}}writeBridge4bOutbox(remaining)}
setTimeout(()=>{flushBridge4bOutbox().catch(()=>{})},15000);

/**
 * Replica atualizacao de status de pedido para Gestor e CRM.
 * Chamada apos handleStatusUpdate / updateOrderStatus na loja.
 *
 * @param {string} orderId - ID do pedido
 * @param {string} newStatus - novo status
 * @param {Object} orderData - dados completos do pedido (opcional)
 */
async function syncOrderStatusToGestorAndCRM(orderId, newStatus, orderData) {
  const patch = {
    id: orderId,
    status: newStatus,
    updatedAt: Date.now(),
    statusHistoryEntry: {
      at: Date.now(),
      status: newStatus,
      message: `Status atualizado pela loja: ${newStatus}`,
    },
  };

  // Acrescenta apenas os campos realmente fornecidos; uma atualização logística
  // parcial nunca pode apagar o snapshot do cliente ou os itens já sincronizados.
  if (orderData) {
    ["storeId", "customerId", "userId", "userName", "userPhone", "userEmail", "customerSnapshot", "addressSnapshot", "total", "items", "dispatchMode", "logistics", "deliveryOffer", "motoboyLocation", "locationSharing", "deliveryAcceptedAt", "deliveryCompletedAt", "deliveredAt", "customerNotification", "statusHistory"].forEach(key => {
      if (orderData[key] !== undefined && orderData[key] !== null) patch[key] = orderData[key];
    });
  }

  const targets = [
    { name: "Gestor", cfg: GESTOR_CFG, collection: "orders" },
    { name: "CRM", cfg: CRM_CFG, collection: "orders" },
    { name: "Marketplace", cfg: MARKETPLACE_CFG, collection: "orders" },
  ];

  const results = await Promise.allSettled(targets.map(t => (window.supremoRestMergeWrite || supremoRestWrite)(t.cfg.projectId, t.cfg.apiKey, t.collection, orderId, patch)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") console.log(`[Bridge4b] Pedido ${orderId} status=${newStatus} replicado para ${targets[i].name}`);
    else { enqueueBridge4b({target:targets[i].name,orderId,patch}); console.warn(`[Bridge4b] ${targets[i].name} indisponível; atualização enfileirada:`, r.reason?.message); }
  });
  await flushBridge4bOutbox();

  // Publicar evento no gestor
  if (window.supremoPublishEvent) {
    try {
      await window.supremoPublishEvent(
        "store",
        `order_${newStatus}`,
        newStatus === "cancelled" ? "warning" : "info",
        `Pedido ${orderId} mudou para ${newStatus}`,
        orderId,
        { status: newStatus, storeId: (window.STORE_IDENTITY || {}).storeId }
      );
    } catch (e) { /* silencioso */ }
  }

  return { ok: results.some(r => r.status === "fulfilled") };
}

/**
 * Replica um motoboy da loja para a Central de Motoboys.
 * Chamada quando a loja cria/edita um motoboy.
 */
async function syncMotoboyToCentral(motoboy) {
  const cfg = SUPREMO_BRIDGE_CONFIG.motoboy;
  if (!cfg?.apiKey || !cfg?.projectId || !motoboy?.id) return { ok: false };

  const payload = {
    id: motoboy.id,
    name: motoboy.name || "",
    email: motoboy.email || "",
    phone: motoboy.phone || "",
    phoneNormalized: motoboy.phoneNormalized || String(motoboy.phone || "").replace(/\D/g, ""),
    loginNameNormalized: motoboy.loginNameNormalized || String(motoboy.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase(),
    vehicleType: motoboy.vehicleType || motoboy.vehicleModel || "Moto",
    vehicleModel: motoboy.vehicleModel || "",
    vehicleColor: motoboy.vehicleColor || "",
    vehiclePlate: motoboy.vehiclePlate || "",
    photo: motoboy.photo || null,
    accountStatus: motoboy.accountStatus || "active",
    approvalSource: "store",
    approvedAt: motoboy.approvedAt || new Date().toISOString(),
    status: motoboy.status || "offline",
    isOnline: motoboy.isOnline || false,
    presence: motoboy.presence || "offline",
    activeOrderId: motoboy.activeOrderId || "",
    infractionPoints: motoboy.infractionPoints || 0,
    source: "store",
    storeId: (window.STORE_IDENTITY || {}).storeId || "",
    storeName: (window.STORE_IDENTITY || {}).storeName || "",
    lastSeenAt: motoboy.lastSeenAt || null,
    motoboyLocation: motoboy.motoboyLocation || null,
    updatedAt: new Date().toISOString(),
  };

  try {
    await (window.supremoRestMergeWrite || supremoRestWrite)(cfg.projectId, cfg.apiKey, "motoboys", motoboy.id, payload);
    console.log("[Bridge-Motoboy] Motoboy replicado para central:", motoboy.id, motoboy.name);
    return { ok: true };
  } catch (e) {
    console.warn("[Bridge-Motoboy] Falha ao replicar motoboy:", e.message);
    return { ok: false, error: e.message };
  }
}

if (typeof window !== "undefined") {
  window.syncOrderStatusToGestorAndCRM = syncOrderStatusToGestorAndCRM;
  window.syncMotoboyToCentral = syncMotoboyToCentral;
}
