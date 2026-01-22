import mongoose, { Schema, Document, Types } from 'mongoose';

export enum AuctionStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export interface IRound {
  roundNumber: number;
  itemsToDistribute: number;
  startTime: Date;
  endTime: Date;
  originalEndTime: Date;  // исходное время без продлений
  extensionCount: number;  // сколько раз продлевали (anti-snipe)
  status: 'pending' | 'active' | 'completed';
  winnersCount: number;
}

export interface IAuction {
  title: string;
  description: string;
  totalItems: number;
  distributedItems: number;
  startingPrice: number;
  minBidIncrement: number;
  rounds: IRound[];
  currentRound: number;
  status: AuctionStatus;
  startTime: Date;
  endTime?: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAuctionDocument extends IAuction, Document {
  getRemainingItems(): number;
  getCurrentRound(): IRound | null;
  isLastRound(): boolean;
}

const roundSchema = new Schema<IRound>(
  {
    roundNumber: { type: Number, required: true },
    itemsToDistribute: { type: Number, required: true, min: 1 },
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    originalEndTime: { type: Date, required: true },
    extensionCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'active', 'completed'],
      default: 'pending',
    },
    winnersCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const auctionSchema = new Schema<IAuctionDocument>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 1024,
      default: '',
    },
    totalItems: {
      type: Number,
      required: true,
      min: 1,
    },
    distributedItems: {
      type: Number,
      default: 0,
      min: 0,
    },
    startingPrice: {
      type: Number,
      required: true,
      min: 1,
    },
    minBidIncrement: {
      type: Number,
      required: true,
      min: 1,
    },
    rounds: [roundSchema],
    currentRound: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: Object.values(AuctionStatus),
      default: AuctionStatus.PENDING,
    },
    startTime: {
      type: Date,
      required: true,
    },
    endTime: Date,
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
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

auctionSchema.index({ status: 1 });
auctionSchema.index({ startTime: 1 });
auctionSchema.index({ 'rounds.endTime': 1 });

auctionSchema.methods.getRemainingItems = function (): number {
  return this.totalItems - this.distributedItems;
};

auctionSchema.methods.getCurrentRound = function (): IRound | null {
  if (this.currentRound >= 0 && this.currentRound < this.rounds.length) {
    return this.rounds[this.currentRound];
  }
  return null;
};

auctionSchema.methods.isLastRound = function (): boolean {
  return this.currentRound === this.rounds.length - 1;
};

export const Auction = mongoose.model<IAuctionDocument>('Auction', auctionSchema);
