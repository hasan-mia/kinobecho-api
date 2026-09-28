import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { StorageService } from '../storage/storage.service';
import { buildStoragePath } from '../storage/storage-path.util';

const KYC_OWNER_TYPE = 'VENDOR_KYC';

@Injectable()
export class VendorKycService {
  private readonly logger = new Logger(VendorKycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async uploadDocuments(
    user: AuthenticatedUser,
    files: Express.Multer.File[],
    documentTypes: string[],
  ) {
    const vendor = await this.requireOwnVendor(user);

    if (!files?.length) {
      throw new ForbiddenException('No files provided');
    }

    const uploaded = [];

    for (const [index, file] of files.entries()) {
      const storageFile = await this.storage.uploadFile(
        file,
        buildStoragePath(KYC_OWNER_TYPE, vendor.id, file),
        {
          ownerType: KYC_OWNER_TYPE,
          ownerId: vendor.id,
          vendorId: vendor.id,
          uploadedById: user.id,
        },
      );

      uploaded.push({
        ...storageFile,
        documentType: documentTypes[index] ?? 'OTHER',
      });
    }

    await this.prisma.vendor.update({
      where: { id: vendor.id },
      data: { kycStatus: 'PENDING' },
    });

    this.logger.log(`Uploaded ${uploaded.length} KYC document(s) for ${vendor.id}`);

    return uploaded;
  }

  async listDocuments(vendorId: string, expiresInSeconds = 900) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, kycStatus: true, status: true },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    const files = await this.prisma.storageFile.findMany({
      where: { ownerType: KYC_OWNER_TYPE, vendorId },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(
      files.map(async (file) => ({
        id: file.id,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        driver: file.driver,
        createdAt: file.createdAt,
        signedUrl: await this.storage.getSignedUrl(file.bucketKey, expiresInSeconds),
      })),
    );
  }

  async listOwnDocuments(user: AuthenticatedUser) {
    const vendor = await this.requireOwnVendor(user);

    return this.listDocuments(vendor.id);
  }

  private async requireOwnVendor(user: AuthenticatedUser) {
    if (!user.vendor) {
      throw new ForbiddenException('Vendor profile not found');
    }

    if (user.role === UserRole.VENDOR || user.role === UserRole.VENDOR_STAFF) {
      return this.prisma.vendor.findUniqueOrThrow({
        where: { id: user.vendor.id },
      });
    }

    const vendor = await this.prisma.vendor.findUnique({
      where: { userId: user.id },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor profile not found');
    }

    return vendor;
  }
}
