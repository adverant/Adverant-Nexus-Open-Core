/**
 * Hardware Detection Module
 *
 * Detects local hardware capabilities including:
 * - Apple Silicon (M1/M2/M3/M4 series)
 * - NVIDIA GPUs
 * - CPU cores and memory
 * - Installed ML frameworks
 */

import os from 'os';
import { execSync } from 'child_process';

export interface HardwareInfo {
  platform: string;
  arch: string;
  hostname: string;
  cpu: CPUInfo;
  memory: MemoryInfo;
  gpu: GPUInfo | null;
  frameworks: FrameworkInfo[];
}

export interface CPUInfo {
  model: string;
  cores: number;
  performanceCores?: number;
  efficiencyCores?: number;
  speed?: number;
}

export interface MemoryInfo {
  total: number;
  available: number;
  unified: boolean;
}

export interface GPUInfo {
  type: string;
  memory: number;
  api: string;
  fp32Tflops?: number;
  fp16Tflops?: number;
  computeCapability?: string;
  neuralEngine?: boolean;
  neuralEngineTops?: number;
}

export interface FrameworkInfo {
  name: string;
  version?: string;
  available: boolean;
  gpuSupport: boolean;
}

/**
 * Apple Silicon GPU Specifications
 */
const APPLE_SILICON_SPECS: Record<string, Partial<GPUInfo>> = {
  'Apple M1': {
    memory: 16,
    fp32Tflops: 2.6,
    fp16Tflops: 5.2,
    neuralEngine: true,
    neuralEngineTops: 11,
    api: 'Metal 3',
  },
  'Apple M1 Pro': {
    memory: 32,
    fp32Tflops: 5.2,
    fp16Tflops: 10.4,
    neuralEngine: true,
    neuralEngineTops: 11,
    api: 'Metal 3',
  },
  'Apple M1 Max': {
    memory: 64,
    fp32Tflops: 10.4,
    fp16Tflops: 20.8,
    neuralEngine: true,
    neuralEngineTops: 11,
    api: 'Metal 3',
  },
  'Apple M1 Ultra': {
    memory: 128,
    fp32Tflops: 20.8,
    fp16Tflops: 41.6,
    neuralEngine: true,
    neuralEngineTops: 22,
    api: 'Metal 3',
  },
  'Apple M2': {
    memory: 24,
    fp32Tflops: 3.6,
    fp16Tflops: 7.2,
    neuralEngine: true,
    neuralEngineTops: 15.8,
    api: 'Metal 3',
  },
  'Apple M2 Pro': {
    memory: 32,
    fp32Tflops: 6.8,
    fp16Tflops: 13.6,
    neuralEngine: true,
    neuralEngineTops: 15.8,
    api: 'Metal 3',
  },
  'Apple M2 Max': {
    memory: 96,
    fp32Tflops: 13.6,
    fp16Tflops: 27.2,
    neuralEngine: true,
    neuralEngineTops: 15.8,
    api: 'Metal 3',
  },
  'Apple M2 Ultra': {
    memory: 192,
    fp32Tflops: 27.2,
    fp16Tflops: 54.4,
    neuralEngine: true,
    neuralEngineTops: 31.6,
    api: 'Metal 3',
  },
  'Apple M3': {
    memory: 24,
    fp32Tflops: 4.0,
    fp16Tflops: 8.0,
    neuralEngine: true,
    neuralEngineTops: 18,
    api: 'Metal 3',
  },
  'Apple M3 Pro': {
    memory: 36,
    fp32Tflops: 7.5,
    fp16Tflops: 15.0,
    neuralEngine: true,
    neuralEngineTops: 18,
    api: 'Metal 3',
  },
  'Apple M3 Max': {
    memory: 128,
    fp32Tflops: 14.2,
    fp16Tflops: 28.4,
    neuralEngine: true,
    neuralEngineTops: 18,
    api: 'Metal 3',
  },
  'Apple M4': {
    memory: 32,
    fp32Tflops: 5.3,
    fp16Tflops: 10.6,
    neuralEngine: true,
    neuralEngineTops: 38,
    api: 'Metal 3',
  },
  'Apple M4 Pro': {
    memory: 48,
    fp32Tflops: 12.0,
    fp16Tflops: 24.0,
    neuralEngine: true,
    neuralEngineTops: 38,
    api: 'Metal 3',
  },
  'Apple M4 Max': {
    memory: 128,
    fp32Tflops: 18.0,
    fp16Tflops: 36.0,
    neuralEngine: true,
    neuralEngineTops: 38,
    api: 'Metal 3',
  },
};

/**
 * Detect all hardware information
 */
export async function detectHardware(): Promise<HardwareInfo> {
  const platform = os.platform();
  const arch = os.arch();
  const hostname = os.hostname();

  const cpu = detectCPU();
  const memory = detectMemory();
  const gpu = await detectGPU();
  const frameworks = await detectFrameworks();

  return {
    platform,
    arch,
    hostname,
    cpu,
    memory,
    gpu,
    frameworks,
  };
}

/**
 * Detect CPU information
 */
function detectCPU(): CPUInfo {
  const cpus = os.cpus();
  const model = cpus[0]?.model || 'Unknown';
  const cores = cpus.length;
  const speed = cpus[0]?.speed;

  // Detect Apple Silicon core configuration
  let performanceCores: number | undefined;
  let efficiencyCores: number | undefined;

  if (model.includes('Apple M')) {
    // Apple Silicon has P-cores and E-cores
    // M4 Max: 16 cores (12P + 4E)
    if (model.includes('M4 Max')) {
      performanceCores = 12;
      efficiencyCores = 4;
    } else if (model.includes('M4 Pro')) {
      performanceCores = 10;
      efficiencyCores = 4;
    } else if (model.includes('M4')) {
      performanceCores = 4;
      efficiencyCores = 6;
    } else if (model.includes('M3 Max')) {
      performanceCores = 12;
      efficiencyCores = 4;
    } else if (model.includes('M3 Pro')) {
      performanceCores = 6;
      efficiencyCores = 6;
    } else if (model.includes('M3')) {
      performanceCores = 4;
      efficiencyCores = 4;
    } else {
      // Generic Apple Silicon estimate
      performanceCores = Math.ceil(cores * 0.75);
      efficiencyCores = cores - performanceCores;
    }
  }

  return {
    model,
    cores,
    performanceCores,
    efficiencyCores,
    speed,
  };
}

/**
 * Detect memory information
 */
function detectMemory(): MemoryInfo {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();

  const total = Math.round(totalBytes / (1024 * 1024 * 1024));
  const available = Math.round(freeBytes / (1024 * 1024 * 1024));

  // Apple Silicon uses unified memory
  const cpus = os.cpus();
  const unified = cpus[0]?.model.includes('Apple M') || false;

  return {
    total,
    available,
    unified,
  };
}

/**
 * Detect GPU/Accelerator
 */
async function detectGPU(): Promise<GPUInfo | null> {
  const platform = os.platform();
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || '';

  // Check for Apple Silicon
  if (cpuModel.includes('Apple M')) {
    // Find matching Apple Silicon specs
    for (const [model, specs] of Object.entries(APPLE_SILICON_SPECS)) {
      if (cpuModel.includes(model.replace('Apple ', ''))) {
        const totalMemory = Math.round(os.totalmem() / (1024 * 1024 * 1024));
        return {
          type: model,
          memory: totalMemory, // Unified memory
          api: specs.api || 'Metal 3',
          fp32Tflops: specs.fp32Tflops,
          fp16Tflops: specs.fp16Tflops,
          computeCapability: 'metal-3',
          neuralEngine: specs.neuralEngine,
          neuralEngineTops: specs.neuralEngineTops,
        };
      }
    }

    // Generic Apple Silicon
    const totalMemory = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    return {
      type: cpuModel,
      memory: totalMemory,
      api: 'Metal 3',
      computeCapability: 'metal-3',
    };
  }

  // Check for NVIDIA GPU on Linux/Windows
  if (platform === 'linux' || platform === 'win32') {
    try {
      const result = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      const lines = result.trim().split('\n');
      if (lines.length > 0) {
        const [name, memoryStr] = lines[0].split(',').map((s) => s.trim());
        const memory = parseInt(memoryStr) / 1024; // Convert MiB to GB

        return {
          type: name,
          memory: Math.round(memory),
          api: 'CUDA',
          computeCapability: await detectCudaCapability(),
        };
      }
    } catch {
      // nvidia-smi not available or no GPU
    }
  }

  return null;
}

/**
 * Detect CUDA compute capability
 */
async function detectCudaCapability(): Promise<string | undefined> {
  try {
    const result = execSync(
      'nvidia-smi --query-gpu=compute_cap --format=csv,noheader',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    );
    return result.trim();
  } catch {
    return undefined;
  }
}

/**
 * Detect installed ML frameworks
 */
async function detectFrameworks(): Promise<FrameworkInfo[]> {
  const frameworks: FrameworkInfo[] = [];
  const platform = os.platform();
  const cpus = os.cpus();
  const isAppleSilicon = cpus[0]?.model.includes('Apple M');

  // Check PyTorch
  try {
    const result = execSync('python3 -c "import torch; print(torch.__version__)"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const version = result.trim();

    // Check for GPU support
    let gpuSupport = false;
    try {
      if (isAppleSilicon) {
        const mpsCheck = execSync('python3 -c "import torch; print(torch.backends.mps.is_available())"', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        gpuSupport = mpsCheck.trim() === 'True';
      } else {
        const cudaCheck = execSync('python3 -c "import torch; print(torch.cuda.is_available())"', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        gpuSupport = cudaCheck.trim() === 'True';
      }
    } catch {
      // GPU check failed
    }

    frameworks.push({
      name: 'PyTorch',
      version,
      available: true,
      gpuSupport,
    });
  } catch {
    frameworks.push({
      name: 'PyTorch',
      available: false,
      gpuSupport: false,
    });
  }

  // Check TensorFlow
  try {
    const result = execSync('python3 -c "import tensorflow as tf; print(tf.__version__)"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const version = result.trim();

    // Check for GPU support
    let gpuSupport = false;
    try {
      const gpuCheck = execSync('python3 -c "import tensorflow as tf; print(len(tf.config.list_physical_devices(\'GPU\')) > 0)"', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      gpuSupport = gpuCheck.trim() === 'True';
    } catch {
      // GPU check failed
    }

    frameworks.push({
      name: 'TensorFlow',
      version,
      available: true,
      gpuSupport,
    });
  } catch {
    frameworks.push({
      name: 'TensorFlow',
      available: false,
      gpuSupport: false,
    });
  }

  // Check MLX (Apple Silicon only)
  if (isAppleSilicon) {
    try {
      const result = execSync('python3 -c "import mlx; print(mlx.__version__)"', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const version = result.trim();

      frameworks.push({
        name: 'MLX',
        version,
        available: true,
        gpuSupport: true, // MLX always uses GPU on Apple Silicon
      });
    } catch {
      frameworks.push({
        name: 'MLX',
        available: false,
        gpuSupport: false,
      });
    }
  }

  // Check JAX
  try {
    const result = execSync('python3 -c "import jax; print(jax.__version__)"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const version = result.trim();

    // Check for GPU support
    let gpuSupport = false;
    try {
      const gpuCheck = execSync('python3 -c "import jax; print(len(jax.devices(\'gpu\')) > 0)"', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      gpuSupport = gpuCheck.trim() === 'True';
    } catch {
      // GPU check failed
    }

    frameworks.push({
      name: 'JAX',
      version,
      available: true,
      gpuSupport,
    });
  } catch {
    frameworks.push({
      name: 'JAX',
      available: false,
      gpuSupport: false,
    });
  }

  return frameworks;
}

export default detectHardware;
