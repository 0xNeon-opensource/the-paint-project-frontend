'use strict';
// import { ethers, Contract } from 'ethers';
// const { ethers } = require("ethers");

const e = React.createElement;

class Blockchain extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      provider: undefined,
      account: undefined,
      balance: undefined,
      colorContract: undefined,
      totalSupply: 0,
      colors: []    
    };
  }

  // Make sure to manually call this in index.html
  async componentDidMount() {
    await this.loadWeb3();
    // await this.loadBlockchainData();
  }

  async loadWeb3() {
    const provider = new ethers.providers.Web3Provider(window.ethereum);
    // Because this whole thing is really hacky, set state incorrectly:
    this.state.provider = provider;
  }

  render() {
    if (this.state.liked) {
      return 'You liked this.';
    }

    return e(
      'button',
      { onClick: () => this.setState({ liked: true }) },
      'Like'
    );
  }

  async connectWallet() {
    await this.state.provider.send("eth_requestAccounts", []);
    const signer = this.state.provider.getSigner();
    const account = await signer.getAddress();
    this.state.account = account;
    accountNumberLabel.innerHTML = "| Connected with " + account;
  }
}

// const domContainer = document.querySelector('#like_button_container');
// ReactDOM.render(e(Blockchain), domContainer);