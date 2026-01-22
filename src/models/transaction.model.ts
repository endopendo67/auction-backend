import mongoose, { Schema, Document, Types } from 'mongoose';

export enum TransactionType {
  DEPOSIT = 'deposit',
  WITHDRAWAL = 'withdrawal',
  BID_LOCK = 'bid_lock',
  BID_UNLOCK = 'bid_unlock',
  BID_INCREASE_LOCK = 'bid_increase_lock',
  WIN_CHARGE = 'win_charge',
  REFUND = 'refund',
}

export interface ITransaction {
  userId: Types.ObjectId;
  type: TransactionType;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  lockedBefore: number;
  lockedAfter: number;
  auctionId?: Types.ObjectId;
  bidId?: Types.ObjectId;
  description: string;
  createdAt: Date;
}

export interface ITransactionDocument extends ITransaction, Document {}

const transactionSchema = new Schema<ITransactionDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: Object.values(TransactionType),
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    balanceBefore: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    lockedBefore: {
      type: Number,
      required: true,
    },
    lockedAfter: {
      type: Number,
      required: true,
    },
    auctionId: {
      type: Schema.Types.ObjectId,
      ref: 'Auction',
    },
    bidId: {
      type: Schema.Types.ObjectId,
      ref: 'Bid',
    },
    description: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = (ret._id as { toString(): string })?.toString();
        ret._id = undefined;
        ret.__v = undefined;
        return ret;
      },
    },
  }
);

transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ auctionId: 1 });
transactionSchema.index({ type: 1, createdAt: -1 });

export const Transaction = mongoose.model<ITransactionDocument>('Transaction', transactionSchema);
