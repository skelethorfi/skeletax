import { type Action, ActionStatusEnum, ActionTypeEnum } from "@xchainjs/xchain-midgard";
import { assetFromStringEx, AssetType } from "@xchainjs/xchain-util";
import { MidgardService } from "./thorchain/MidgardService.ts";
import { ThornodeService } from "./thorchain/ThornodeService.ts";
import { CosmosTxService, getCosmosTxIds } from "./thorchain/CosmosTxService.ts";
import { MayanodeService } from "./maya/MayanodeService.ts";
import { TcyDistributionService } from "./tcy/TcyDistributionService.ts";
import type { MayaDistributionService } from "./maya/MayaDistributionService.ts";
import type { TcyClaimService } from "./tcy/TcyClaimService.ts";
import { MAYA } from "../domain/Protocol.ts";
import { getActionDate, needsRunePrice } from "./thorchain/MidgardUtils.ts";
import { Viewblock, type ViewblockInbound } from "./viewblock/index.ts";
import { EvmReceipts, isEvmChain, type EvmReceipt } from "./evm/EvmReceipts.ts";
import { failedTxPaidFee, type Protocol, THORCHAIN } from "../domain/Protocol.ts";
import { getBundleKey, type RawBundle } from "./RawBundle.ts";
import type { NotFinal } from "./Pending.ts";

// Lists the raw bundles of one wallet from one API
export interface Source {
  bundlesFor(wallet: string): Promise<RawBundle[]>;
}

// An inbound transaction the wallet sent, and the asset it sent
export interface InboundTx {
  txId: string;
  asset: string;
}

// The inbound txs to look up on THORNode, Viewblock and an EVM chain, the sources of the gas the wallet paid on an
// L1 chain (docs/specs/fees.md). A refund's is looked up to see what the wallet sent, not only for its gas.
// The asset is the one sent: a savers deposit from an L1 wallet sent the L1 asset, which Midgard names as the synth.
export function getInboundTxs(action: Action, protocol: Protocol = THORCHAIN): InboundTx[] {
  const inbounds = action.in ?? [];
  let txs: { txId?: string; asset?: string }[] = [];
  const sent = (inbound: Action["in"][number]) => ({ txId: inbound.txID, asset: sentAsset(inbound, protocol) });

  if (
    action.type === ActionTypeEnum.Swap ||
    action.type === ActionTypeEnum.Switch ||
    action.type === ActionTypeEnum.Refund
  ) {
    txs = inbounds.slice(0, 1).map(sent);
  } else if (action.type === ActionTypeEnum.AddLiquidity || action.type === ActionTypeEnum.Withdraw) {
    // Deposits and withdrawal requests sent on THORChain pay the native fee, so only L1 ones are looked up
    txs = inbounds.map(sent).filter((tx) => isL1Asset(tx.asset));
  }

  // Old Midgard reports LP positions from before its start with the placeholder txid 'genesisTx'
  const unique = new Map<string, InboundTx>();
  txs
    .filter((tx) => !!tx.txId && tx.txId !== "genesisTx")
    .forEach((tx) => unique.has(tx.txId!) || unique.set(tx.txId!, { txId: tx.txId!, asset: tx.asset ?? "" }));
  return [...unique.values()];
}

export function getThornodeTxIds(action: Action): string[] {
  return getInboundTxs(action).map((tx) => tx.txId);
}

// Midgard reports a savers deposit's coin as the synth (BTC/BTC), but a wallet on the asset's own chain sent the
// L1 asset (savers.md)
function sentAsset(inbound: Action["in"][number], protocol: Protocol): string | undefined {
  const asset = inbound.coins[0]?.asset;
  const fromL1 = !!inbound.address && !inbound.address.toLowerCase().startsWith(protocol.nativeAddressPrefix);
  return asset && fromL1 && asset.includes("/") ? asset.replace("/", ".") : asset;
}

// Sent on its own chain, other than THORChain: a coin or a token (e.g. ETH.USDC-0X…)
export function isL1Asset(asset?: string): boolean {
  if (!asset) {
    return false;
  }

  const { chain, type } = assetFromStringEx(asset);

  return chain !== "THOR" && (type === AssetType.NATIVE || type === AssetType.TOKEN);
}

export function shouldIncludeAction(action: Action): boolean {
  if (action.status === ActionStatusEnum.Success) {
    return true;
  }

  const txType = (action.metadata.swap as any)?.txType;

  // Loan repayments show as 'pending' if the loan is not closed
  if (txType === "loanRepayment") {
    return true;
  }

  // A loan open with an output was paid out, whatever its status. Midgard reports loan opens that
  // borrowed RUNE as 'pending' (the RUNE payout has no txid). See docs/specs/loans.md.
  if (txType === "loanOpen") {
    return action.out.some((out) => out.coins.length > 0);
  }

  return false;
}

// A swap, not a loan, with no coins paid out
function isUnpaidSwap(action: Action): boolean {
  const txType = (action.metadata.swap as any)?.txType;
  return (
    action.type === ActionTypeEnum.Swap &&
    txType !== "loanOpen" &&
    txType !== "loanRepayment" &&
    action.in[0]?.coins[0]?.asset !== "THOR.TOR" &&
    !action.out.some((out) => out.coins.length > 0)
  );
}

// The outbound of a swap whose memo ends in an aggregator's final token, when it is on an EVM chain
// (=:ASSET:DEST:LIMIT:AFFILIATE:FEE:AGGREGATOR:FINAL:MIN; docs/specs/activity.md, Aggregator payouts)
export function getAggregatorOutbound(
  action: Action,
): { chain: string; txId: string; to: string; tail: string } | undefined {
  const parts = ((action.metadata?.swap?.memo as string | undefined) ?? "").split(":");
  const [to, tail] = [parts[2], parts[7]];
  const out = action.out?.find((tx) => tx.address?.toLowerCase() === to?.toLowerCase());
  const asset = out?.coins[0]?.asset;

  const txType = (action.metadata?.swap as any)?.txType;

  if (
    action.type !== ActionTypeEnum.Swap ||
    txType === "loanOpen" ||
    txType === "loanRepayment" ||
    action.in?.[0]?.coins[0]?.asset === "THOR.TOR" ||
    !tail ||
    !out?.txID ||
    !asset ||
    !isL1Asset(asset)
  ) {
    return undefined;
  }

  const { chain } = assetFromStringEx(asset);
  return isEvmChain(chain) ? { chain, txId: out.txID, to, tail } : undefined;
}

// Where the gas of an L1 inbound comes from when it is not THORNode (docs/specs/fees.md)
export interface InboundGasSources {
  viewblock: Viewblock;
  evm: EvmReceipts;
}

// Midgard actions of one protocol. Only THORChain actions get their THORNode, Cosmos and inbound gas txs.
// notFinal: collects every action whose status is not 'success', exported or not, for the run summary.
// stuckBefore: an action still pending from before this date is stuck (docs/specs/pending.md)
export class MidgardSource implements Source {
  private protocol: Protocol;
  private midgard: MidgardService;
  private thornode: ThornodeService;
  private cosmosTxs: CosmosTxService;
  private notFinal: NotFinal[];
  private stuckBefore?: Date;
  private mayanode?: MayanodeService;
  private inboundGas?: InboundGasSources;
  private tcyClaims?: TcyClaimService;
  constructor(
    protocol: Protocol,
    midgard: MidgardService,
    thornode: ThornodeService,
    cosmosTxs: CosmosTxService,
    notFinal: NotFinal[] = [],
    stuckBefore?: Date,
    mayanode?: MayanodeService,
    inboundGas?: InboundGasSources,
    tcyClaims?: TcyClaimService,
  ) {
    this.protocol = protocol;
    this.midgard = midgard;
    this.thornode = thornode;
    this.cosmosTxs = cosmosTxs;
    this.notFinal = notFinal;
    this.stuckBefore = stuckBefore;
    this.mayanode = mayanode;
    this.inboundGas = inboundGas;
    this.tcyClaims = tcyClaims;
  }

  async bundlesFor(wallet: string): Promise<RawBundle[]> {
    const actions = await this.midgard.getActions(wallet);
    const keyOf = (action: Action) =>
      getBundleKey({
        source: "midgard",
        protocol: this.protocol.id,
        wallet,
        data: action,
        thornodeTxs: [],
        cosmosTxs: [],
      });
    // Successful actions by inbound txid; a send is left out, as it is how the wallet paid, not what it got
    const settled = new Map(
      actions
        .filter(
          (action) =>
            action.status === ActionStatusEnum.Success && action.type !== ActionTypeEnum.Send && action.in[0]?.txID,
        )
        .map((action) => [action.in[0].txID, keyOf(action)]),
    );
    // How many actions other than sends each inbound txid has, whatever their status
    const inbounds = new Map<string, number>();
    actions
      .filter((action) => action.type !== ActionTypeEnum.Send && action.in[0]?.txID)
      .forEach((action) => inbounds.set(action.in[0].txID, (inbounds.get(action.in[0].txID) ?? 0) + 1));
    const bundles: RawBundle[] = [];

    for (const action of actions) {
      let included = shouldIncludeAction(action);

      if (action.status !== ActionStatusEnum.Success) {
        const coveredBy = settled.get(action.in[0]?.txID ?? "");
        // A stuck swap shares its coin with any other action of its txid (e.g. a pending refund): listed only
        const shared = action.type === ActionTypeEnum.Swap && (inbounds.get(action.in[0]?.txID ?? "") ?? 0) > 1;
        included ||= !coveredBy && !shared && this.isStuckLoss(action);
        included ||= this.isFailedSendWithFee(action);
        this.notFinal.push({ key: keyOf(action), action, exported: included, ...(coveredBy ? { coveredBy } : {}) });
      }

      if (included) {
        bundles.push(await this.bundle(action, wallet));
      }
    }

    return bundles;
  }

  // A refund, or a swap that paid nothing out, still pending past the cut-off will not be paid out: it is
  // exported, and what was not returned is lost (docs/specs/pending.md). A loan is left to shouldIncludeAction.
  private isStuckLoss(action: Action): boolean {
    return (
      (action.type === ActionTypeEnum.Refund || isUnpaidSwap(action)) &&
      !!this.stuckBefore &&
      getActionDate(action) < this.stuckBefore
    );
  }

  // A failed send moved nothing, but from the protocol's failedTxFeeFromHeight it still paid the native fee
  // (docs/specs/sends.md)
  private isFailedSendWithFee(action: Action): boolean {
    return (
      action.type === ActionTypeEnum.Send &&
      action.status === ActionStatusEnum.Failed &&
      failedTxPaidFee(this.protocol, Number(action.height))
    );
  }

  // The bundle of one action; the fixture tool uses this for an action it looked up by txid
  async bundle(action: Action, wallet: string): Promise<RawBundle> {
    const isThorchain = this.protocol.id === THORCHAIN.id;
    const thornodeTxs = [];
    const cosmosTxs = [];

    const viewblockInbounds: ViewblockInbound[] = [];
    const evmReceipts: EvmReceipt[] = [];

    for (const { txId, asset } of isThorchain ? getInboundTxs(action, this.protocol) : []) {
      const status = await this.thornode.getTxStatus(txId, getActionDate(action), Number(action.height));
      thornodeTxs.push(status);
      const chain = isL1Asset(asset) ? assetFromStringEx(asset).chain : undefined;

      if (!chain || !this.inboundGas) {
        continue;
      }

      // An EVM chain's own receipt is what the wallet paid; THORNode's gas is the max fee. Elsewhere THORNode's
      // gas is exact, and Viewblock keeps it for the txs THORNode has pruned (docs/specs/fees.md)
      if (isEvmChain(chain)) {
        const receipt = await this.inboundGas.evm.getReceipt(chain, txId, getActionDate(action));

        if (receipt) {
          evmReceipts.push(receipt);
        }
      } else if (!status.tx?.gas?.length) {
        const observed = await this.inboundGas.viewblock.getInbound(txId, getActionDate(action));

        if (observed) {
          viewblockInbounds.push(observed);
        }
      }
    }

    const aggregator = isThorchain && this.inboundGas ? getAggregatorOutbound(action) : undefined;
    const tokenPayout = aggregator
      ? await this.inboundGas!.evm.getTokenPayout(
          aggregator.chain,
          aggregator.txId,
          aggregator.to,
          aggregator.tail,
          getActionDate(action),
        )
      : undefined;

    for (const txId of isThorchain ? getCosmosTxIds(action) : []) {
      cosmosTxs.push(await this.cosmosTxs.getTx(txId, getActionDate(action)));
    }

    // Maya's native fee has changed over time: the setting at the action's height (docs/specs/maya.md, Fees)
    const nativeFee = this.mayanode
      ? (await this.mayanode.nativeFee(Number(action.height), getActionDate(action))).amount
      : undefined;

    const runePriceUsd =
      isThorchain && needsRunePrice(action)
        ? (await this.midgard.getRunePrice(getActionDate(action))).runePriceUSD
        : undefined;

    // What a TCY claim was for: the claim list and the claiming address's positions (docs/specs/thorfi-collapse.md)
    const tcyClaim =
      isThorchain && this.tcyClaims && (action.type as string) === "tcy_claim" && action.in[0]?.address
        ? await this.tcyClaims.getClaim(action.in[0].address, Number(action.height), getActionDate(action))
        : undefined;

    return {
      source: "midgard",
      protocol: this.protocol.id,
      wallet,
      data: action,
      thornodeTxs,
      cosmosTxs,
      ...(viewblockInbounds.length ? { viewblockInbounds } : {}),
      ...(evmReceipts.length ? { evmReceipts } : {}),
      ...(tokenPayout ? { tokenPayout } : {}),
      ...(nativeFee ? { nativeFee } : {}),
      ...(runePriceUsd ? { runePriceUsd } : {}),
      ...(tcyClaim ? { tcyClaim } : {}),
    };
  }
}

// Viewblock's txs of a THORChain wallet, for the sends Midgard does not list (docs/specs/sends.md);
// selectSends keeps those
export class ViewblockSource implements Source {
  private viewblock: Viewblock;
  constructor(viewblock: Viewblock) {
    this.viewblock = viewblock;
  }

  async bundlesFor(wallet: string): Promise<RawBundle[]> {
    if (!wallet.toLowerCase().startsWith("thor1")) {
      return [];
    }

    const txs = await this.viewblock.getTxs(wallet);
    return txs.map((tx) => ({
      source: "viewblock",
      protocol: THORCHAIN.id,
      wallet,
      data: tx,
      thornodeTxs: [],
      cosmosTxs: [],
    }));
  }
}

// TCY distributions, for THORChain wallets only
export class TcySource implements Source {
  private tcyDistribution: TcyDistributionService;
  constructor(tcyDistribution: TcyDistributionService) {
    this.tcyDistribution = tcyDistribution;
  }

  async bundlesFor(wallet: string): Promise<RawBundle[]> {
    if (!wallet.toLowerCase().startsWith("thor1")) {
      return [];
    }

    const { distributions } = await this.tcyDistribution.getTcyDistribution(wallet);
    return (distributions || []).map((item) => ({
      source: "tcy",
      protocol: THORCHAIN.id,
      wallet,
      data: item,
      thornodeTxs: [],
      cosmosTxs: [],
    }));
  }
}

// CACAO payouts to MAYA holders, for Maya wallets that have received MAYA: from the first payout after the first receipt
// (docs/specs/maya.md, CACAO to MAYA holders)
export class MayaDistributionSource implements Source {
  private midgard: MidgardService;
  private distribution: MayaDistributionService;
  constructor(midgard: MidgardService, distribution: MayaDistributionService) {
    this.midgard = midgard;
    this.distribution = distribution;
  }

  async bundlesFor(wallet: string): Promise<RawBundle[]> {
    if (!wallet.toLowerCase().startsWith(MAYA.nativeAddressPrefix)) {
      return [];
    }

    const actions = await this.midgard.getActions(wallet);
    const receipts = actions.filter((action) =>
      action.out.some((out) => out.address === wallet && out.coins.some((coin) => coin.asset === "MAYA")),
    );

    if (receipts.length === 0) {
      return [];
    }

    const firstHeight = Math.min(...receipts.map((action) => Number(action.height)));
    // An action can pay the wallet out in a later block than its own (e.g. a streaming swap)
    const actionHeights = new Set(
      actions
        .flatMap((action) => [action.height, ...action.out.map((out) => out.height)])
        .filter((height): height is string => !!height)
        .map(Number),
    );
    const payouts = await this.distribution.getPayouts(wallet, firstHeight, actionHeights);
    return payouts.map((payout) => ({
      source: "maya-distribution",
      protocol: MAYA.id,
      wallet,
      data: payout,
      thornodeTxs: [],
      cosmosTxs: [],
    }));
  }
}
