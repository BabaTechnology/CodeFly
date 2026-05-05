import { execFile } from "node:child_process";
import { promisify } from "node:util";
import si from "systeminformation";

const execFileAsync = promisify(execFile);

export interface HostSoftwareStatus {
  uptimeSeconds: number;
  systemVersion: string;
  pythonVersion?: string | null;
  nodeVersion: string;
  cudaVersion?: string | null;
  gpuDriverVersion?: string | null;
}

export interface CpuCoreStatus {
  id: string;
  usagePercent: number;
}

export interface CpuStatusSnapshot {
  model: string;
  overallUsagePercent: number;
  cores: CpuCoreStatus[];
}

export interface MemoryStatusSnapshot {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export interface DiskStatusSnapshot {
  id: string;
  fs: string;
  mount: string;
  type: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export interface GpuStatusSnapshot {
  id: string;
  model: string;
  vendor: string;
  usagePercent?: number | null;
  memoryTotalMiB?: number | null;
  memoryUsedMiB?: number | null;
  memoryBandwidthPercent?: number | null;
  powerDrawWatts?: number | null;
  powerLimitWatts?: number | null;
  fanSpeedPercent?: number | null;
  driverVersion?: string | null;
}

export interface NetworkInterfaceStatusSnapshot {
  id: string;
  displayName: string;
  operational: boolean;
  linkSpeedMbit?: number | null;
  rxBytesPerSecond?: number | null;
  txBytesPerSecond?: number | null;
  rxBytes?: number | null;
  txBytes?: number | null;
}

export interface HostHardwareSnapshot {
  timestamp: string;
  software: HostSoftwareStatus;
  cpu: CpuStatusSnapshot;
  memory: MemoryStatusSnapshot;
  disks: DiskStatusSnapshot[];
  gpus: GpuStatusSnapshot[];
  network: NetworkInterfaceStatusSnapshot[];
}

export async function collectHostHardwareSnapshot(): Promise<HostHardwareSnapshot> {
  const [
    time,
    osInfo,
    versions,
    cpu,
    currentLoad,
    memory,
    fsSizes,
    graphics,
    networkInterfaces,
    networkStats,
    detectedCudaVersion
  ] = await Promise.all([
    si.time(),
    si.osInfo(),
    si.versions(),
    si.cpu(),
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.graphics(),
    si.networkInterfaces(),
    si.networkStats(),
    detectCudaVersion()
  ]);

  const gpuDriverVersion =
    graphics.controllers.find((controller) => controller.driverVersion)?.driverVersion ?? null;
  const cudaVersion =
    detectedCudaVersion ??
    (typeof (versions as Record<string, unknown>).cuda === "string"
      ? String((versions as Record<string, unknown>).cuda)
      : null) ??
    graphics.controllers
      .map((controller) => getControllerString(controller, "cudaVersion"))
      .find((value): value is string => Boolean(value)) ??
    graphics.controllers
      .map((controller) => getControllerNumber(controller, "cudaVersion"))
      .find((value): value is number => value !== null)
      ?.toString() ??
    null;

  return {
    timestamp: new Date().toISOString(),
    software: {
      uptimeSeconds: time.uptime,
      systemVersion: [osInfo.distro, osInfo.release, osInfo.build].filter(Boolean).join(" "),
      pythonVersion: versions.python || null,
      nodeVersion: process.version,
      cudaVersion,
      gpuDriverVersion
    },
    cpu: {
      model: [cpu.manufacturer, cpu.brand].filter(Boolean).join(" "),
      overallUsagePercent: round(loadOrZero(currentLoad.currentLoad)),
      cores: currentLoad.cpus.map((entry, index) => ({
        id: `core ${index}`,
        usagePercent: round(loadOrZero(entry.load))
      }))
    },
    memory: {
      totalBytes: memory.total,
      usedBytes: memory.active || Math.max(memory.total - memory.available, 0),
      availableBytes: memory.available,
      usagePercent: round(memory.total > 0 ? ((memory.total - memory.available) / memory.total) * 100 : 0)
    },
    disks: fsSizes.map((entry, index) => ({
      id: entry.fs || `disk-${index}`,
      fs: entry.fs || `disk-${index}`,
      mount: entry.mount || entry.fs || `disk-${index}`,
      type: entry.type || "unknown",
      totalBytes: entry.size || 0,
      usedBytes: entry.used || 0,
      availableBytes: Math.max((entry.size || 0) - (entry.used || 0), 0),
      usagePercent: round(entry.use || 0)
    })),
    gpus: graphics.controllers
      .filter((controller) => /nvidia/i.test(`${controller.vendor} ${controller.model}`))
      .map((controller, index) => ({
        id: `GPU ${index}`,
        model: controller.model || `GPU ${index}`,
        vendor: controller.vendor || "Unknown",
        usagePercent: nullableNumber(controller.utilizationGpu),
        memoryTotalMiB: nullableNumber(controller.memoryTotal),
        memoryUsedMiB: nullableNumber(controller.memoryUsed),
        memoryBandwidthPercent: getControllerNumber(controller, "memoryUtilization"),
        powerDrawWatts: nullableNumber(controller.powerDraw),
        powerLimitWatts: nullableNumber(controller.powerLimit),
        fanSpeedPercent: nullableNumber(controller.fanSpeed),
        driverVersion: controller.driverVersion || null
      })),
    network: networkInterfaces.map((iface) => {
      const stats = networkStats.find((entry) => entry.iface === iface.iface);
      return {
        id: iface.iface,
        displayName: iface.ifaceName || iface.iface,
        operational: iface.operstate === "up",
        linkSpeedMbit: nullableNumber(iface.speed),
        rxBytesPerSecond: nullableNumber(stats?.rx_sec),
        txBytesPerSecond: nullableNumber(stats?.tx_sec),
        rxBytes: nullableNumber(stats?.rx_bytes),
        txBytes: nullableNumber(stats?.tx_bytes)
      };
    })
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  return value;
}

function loadOrZero(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  return value;
}

function getControllerNumber(controller: unknown, key: string): number | null {
  if (!controller || typeof controller !== "object") {
    return null;
  }

  const value = (controller as Record<string, unknown>)[key];
  return nullableNumber(value);
}

function getControllerString(controller: unknown, key: string): string | null {
  if (!controller || typeof controller !== "object") {
    return null;
  }

  const value = (controller as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function detectCudaVersion(): Promise<string | null> {
  const candidates =
    process.platform === "win32"
      ? [["nvidia-smi.exe"], ["nvidia-smi"]]
      : [["nvidia-smi"]];

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate[0], []);
      const match = stdout.match(/CUDA Version:\s*([0-9.]+)/i);
      if (match?.[1]) {
        return match[1];
      }
    } catch {
      continue;
    }
  }

  return null;
}
