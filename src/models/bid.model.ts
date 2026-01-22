import mongoose, { Schema, Document, Types, Model } from 'mongoose';

export enum BidStatus {
  ACTIVE = 'active',           // активная ставка
  OUTBID = 'outbid',           // перебита (не используется в текущей логике)
  WON = 'won',                 // выиграла
  CARRIED_OVER = 'carried_over', // перенесена в следующий раунд
  REFUNDED = 'refunded',       // возвращена
  CANCELLED = 'cancelled',     // отменена
}

export interface IBid {
  auctionId: Types.ObjectId;
  userId: Types.ObjectId;
  amount: number;
  round: number;
  status: BidStatus;
  itemNumber?: number;  // номер выигранного товара
  previousBidId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBidDocument extends IBid, Document {}

export interface IBidModel extends Model<IBidDocument> {
  getLeaderboard(auctionId: Types.ObjectId, limit?: number): Promise<IBidDocument[]>;
  getUserActiveBid(auctionId: Types.ObjectId, userId: Types.ObjectId): Promise<IBidDocument | null>;
}

const bidSchema = new Schema<IBidDocument>(
  {
    auctionId: {
      type: Schema.Types.ObjectId,
      ref: 'Auction',
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    round: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: Object.values(BidStatus),
      default: BidStatus.ACTIVE,
    },
    itemNumber: {
      type: Number,
      min: 1,
    },
    previousBidId: {
      type: Schema.Types.ObjectId,
      ref: 'Bid',
    },
  },
  {
    timestamps: true,
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

// Индексы для быстрого поиска
bidSchema.index({ auctionId: 1, amount: -1 });
bidSchema.index({ auctionId: 1, userId: 1 });
bidSchema.index({ auctionId: 1, status: 1 });
bidSchema.index({ auctionId: 1, round: 1, amount: -1 });
bidSchema.index({ userId: 1, status: 1 });

// Получить лидерборд по аукциону
bidSchema.statics.getLeaderboard = function (
  auctionId: Types.ObjectId,
  limit = 100
): Promise<IBidDocument[]> {
  return this.find({
    auctionId,
    status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
  })
    .sort({ amount: -1, createdAt: 1 })
    .limit(limit)
    .populate('userId', 'username')
    .exec();
};

// Получить активную ставку пользователя
bidSchema.statics.getUserActiveBid = function (
  auctionId: Types.ObjectId,
  userId: Types.ObjectId
): Promise<IBidDocument | null> {
  return this.findOne({
    auctionId,
    userId,
    status: { $in: [BidStatus.ACTIVE, BidStatus.CARRIED_OVER] },
  }).exec();
};

export const Bid = mongoose.model<IBidDocument, IBidModel>('Bid', bidSchema);
