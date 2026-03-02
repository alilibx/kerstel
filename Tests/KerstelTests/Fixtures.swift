import Foundation

enum Fixtures {

    // MARK: - vm_stat

    static let vmStatOutput = """
    Mach Virtual Memory Statistics: (page size of 16384 bytes)
    Pages free:                               72463.
    Pages active:                            389928.
    Pages inactive:                          382498.
    Pages speculative:                         4747.
    Pages throttled:                              0.
    Pages wired down:                        120832.
    Pages purgeable:                          30217.
    Pages stored in compressor:              200945.
    Pages occupied by compressor:             62893.
    Decompressions:                        19283746.
    Compressions:                          28374651.
    Pageins:                               12938475.
    Pageouts:                                283746.
    Swapins:                                      0.
    Swapouts:                                     0.
    File-backed pages:                       185302.
    Anonymous pages:                         591871.
    """

    // MARK: - sysctl hw.memsize

    static let sysctlMemsize = "25769803776\n" // 24 GB

    // MARK: - top (CPU)

    static let topOutput = """
    Processes: 478 total, 3 running, 475 sleeping, 2187 threads
    Load Avg: 2.45, 2.18, 2.07
    CPU usage: 5.26% user, 10.75% sys, 83.98% idle
    SharedLibs: 652M resident, 109M data, 68M linkedit.
    MemRegions: 384629 total, 5780M resident, 257M private, 2467M shared.
    PhysMem: 22G used (3125M wired, 2908M compressor), 1835M unused.
    VM: 248T vsize, 4119M framework vsize, 0(0) swapins, 0(0) swapouts.
    Networks: packets: 4826194/4233M in, 3291846/982M out.
    Disks: 9283746/218G read, 7283641/142G written.
    """

    // MARK: - sysctl cpu brand

    static let cpuBrand = "Apple M2 Pro\n"

    // MARK: - df

    static let dfOutput = """
    Filesystem     Size   Used  Avail Capacity  iused ifree %iused  Mounted on
    /dev/disk3s1s1  494G   215G   252G    47%  502312 2642840288    0%   /
    """

    // MARK: - system_profiler SPDisplaysDataType

    static let systemProfilerGPU = """
    Graphics/Displays:

        Apple M2 Pro:

          Chipset Model: Apple M2 Pro
          Type: GPU
          Bus: Built-In
          Total Number of Cores: 19
          Vendor: Apple (0x106b)
          Metal Support: Metal 3
          Displays:
            Color LCD:
              Display Type: Built-In Retina LCD
    """

    // MARK: - pmset (battery charging)

    static let pmsetCharging = """
    Now drawing from 'AC Power'
     -InternalBattery-0 (id=4522083)	78%; charging; 1:23 remaining present: true
    """

    // MARK: - pmset (battery discharging)

    static let pmsetDischarging = """
    Now drawing from 'Battery Power'
     -InternalBattery-0 (id=4522083)	45%; discharging; 3:47 remaining present: true
    """

    // MARK: - pmset (no battery / desktop)

    static let pmsetNoBattery = """
    Now drawing from 'AC Power'
    """

    // MARK: - ps (top processes)

    static let psOutput = """
      PID  %CPU %MEM   RSS COMMAND
    12345  25.3  4.2 345600 /Applications/Safari.app/Contents/MacOS/Safari
      678  18.7  8.1 672000 /Applications/Xcode.app/Contents/MacOS/Xcode
      901  12.1  2.3 190464 /usr/sbin/WindowServer
      234   8.5  1.5 122880 /Applications/Slack.app/Contents/MacOS/Slack
      567   5.2  0.8  65536 /usr/libexec/rapportd
    """

    // MARK: - lsof (ports)

    static let lsofOutput = """
    COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
    node      12345    ali   23u  IPv4 0x1234567890abcdef      0t0  TCP *:3000 (LISTEN)
    ruby      67890    ali   11u  IPv4 0xabcdef1234567890      0t0  TCP 127.0.0.1:8080 (LISTEN)
    Python    11111    ali    5u  IPv6 0x1111111111111111      0t0  TCP [::1]:7679 (LISTEN)
    nginx      2222   root    6u  IPv4 0x2222222222222222      0t0  TCP *:443 (LISTEN)
    postgres   3333    ali    4u  IPv4 0x3333333333333333      0t0  TCP 127.0.0.1:5432 (LISTEN)
    """

    // MARK: - lsof with duplicates

    static let lsofDuplicates = """
    COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
    node      12345    ali   23u  IPv4 0x1234567890abcdef      0t0  TCP *:3000 (LISTEN)
    node      12345    ali   24u  IPv6 0xabcdef1234567890      0t0  TCP *:3000 (LISTEN)
    """
}
