import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IUser {
  username: string;
  balance: number;
  lockedBalance: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserDocument extends IUser, Document {}

export interface IUserModel extends Model<IUserDocument> {
  findByUsername(username: string): Promise<IUserDocument | null>;
}

const userSchema = new Schema<IUserDocument>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 32,
    },
    balance: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    lockedBalance: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
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

userSchema.statics.findByUsername = function (username: string) {
  return this.findOne({ username });
};

userSchema.virtual('availableBalance').get(function () {
  return this.balance - this.lockedBalance;
});

export const User = mongoose.model<IUserDocument, IUserModel>('User', userSchema);
